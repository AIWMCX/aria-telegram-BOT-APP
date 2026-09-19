/**
 * LIVE 0.1 §5 — TradeIntent: the mandatory boundary between strategy and
 * money.
 *
 * Two hard rules from the spec are enforced here STRUCTURALLY — by the
 * shape of the transition table, not by a comment asking future authors to
 * be careful:
 *
 *   1. **UNKNOWN is never collapsed into FAILED.** Every transition
 *      requires a *cause*, and the only causes that can reach FAILED are
 *      `preflight_rejected`, `retrieved_error` and `proven_not_included`.
 *      There is no cause in the union named for a timeout, a deadline or
 *      an elapsed window that reaches FAILED — `confirmation_deadline_elapsed`
 *      and `submission_call_indeterminate` reach UNKNOWN and nothing else.
 *      A future author cannot write the timeout→FAILED edge without
 *      editing this table, which is a reviewable act.
 *
 *   2. **SUBMITTED is not success and CONFIRMED is not a position.**
 *      There is no predicate in this module that returns true for
 *      SUBMITTED in any success sense. `isOnChainSuccessConfirmed` covers
 *      CONFIRMED and RECONCILED; `isPositionBearing` covers RECONCILED
 *      alone. `confirmedAt` is only ever emitted by a transition INTO a
 *      genuinely confirmed state, and the migration carries the matching
 *      CHECK constraint so the database refuses the row too.
 *
 * Pure. No I/O, no database. Persistence — including the UNIQUE
 * idempotency constraint that is the only duplicate guard holding under
 * concurrency — lives in src/live/live-intents-repo.ts.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { LIVE_TIMING } from "./live-limits.js";
import { quotedLamports, type QuotedLamports } from "./money.js";

export const TRADE_INTENT_STATES = [
  "CREATED", "REJECTED", "APPROVED", "AWAITING_SIGNATURE", "SIGNED",
  "SUBMITTED", "CONFIRMED", "RECONCILED", "FAILED", "UNKNOWN", "EXPIRED",
] as const;
export type TradeIntentState = (typeof TRADE_INTENT_STATES)[number];

/**
 * UNKNOWN is deliberately absent: it is a state to be RESOLVED, not an
 * outcome to be recorded. An account holding an UNKNOWN intent cannot arm
 * (firewall F17), which is what makes leaving it non-terminal safe.
 */
export const TERMINAL_INTENT_STATES: ReadonlySet<TradeIntentState> = new Set([
  "REJECTED", "FAILED", "EXPIRED", "RECONCILED",
]);

/**
 * Why a transition is happening. This union is the load-bearing safety
 * mechanism of this module: a state pair alone would allow
 * "SUBMITTED → FAILED because we got bored waiting", which is how systems
 * of this shape lose money twice.
 */
export type IntentTransitionCause =
  | "firewall_rejected"
  | "firewall_approved"
  | "delivered_to_client"
  | "signature_received_and_verified"
  | "submission_accepted"
  /** A retrieved, pre-flight rejection from the RPC. Not a timeout. */
  | "preflight_rejected"
  /** A RETRIEVED `err != null` on the signature status. Not a timeout. */
  | "retrieved_error"
  /** Blockhash provably expired past the safety margin. Not a timeout. */
  | "proven_not_included"
  /** A retrieved, successful signature status. */
  | "retrieved_success"
  /** The submit call errored or timed out with no usable response. */
  | "submission_call_indeterminate"
  /** The §11 hard deadline elapsed. Reaches UNKNOWN. NEVER FAILED. */
  | "confirmation_deadline_elapsed"
  | "recovery_inconclusive"
  | "reconciliation_completed"
  | "reconciliation_unparseable"
  | "ttl_elapsed";

type TransitionTable = {
  readonly [From in TradeIntentState]?: {
    readonly [To in TradeIntentState]?: readonly IntentTransitionCause[];
  };
};

/**
 * Spec §5.2, transcribed edge for edge. Every terminal state is simply
 * absent as a key — a terminal state has no outgoing edges at all, so
 * "resurrecting" one is not something the table can express.
 */
export const INTENT_TRANSITIONS: TransitionTable = {
  CREATED: {
    REJECTED: ["firewall_rejected"],
    APPROVED: ["firewall_approved"],
    EXPIRED: ["ttl_elapsed"],
  },
  APPROVED: {
    AWAITING_SIGNATURE: ["delivered_to_client"],
    EXPIRED: ["ttl_elapsed"],
    REJECTED: ["firewall_rejected"],
  },
  AWAITING_SIGNATURE: {
    SIGNED: ["signature_received_and_verified"],
    EXPIRED: ["ttl_elapsed"],
    REJECTED: ["firewall_rejected"],
  },
  SIGNED: {
    SUBMITTED: ["submission_accepted"],
    FAILED: ["preflight_rejected"],
    UNKNOWN: ["submission_call_indeterminate"],
  },
  SUBMITTED: {
    CONFIRMED: ["retrieved_success"],
    FAILED: ["retrieved_error"],
    UNKNOWN: ["confirmation_deadline_elapsed"],
  },
  CONFIRMED: {
    RECONCILED: ["reconciliation_completed"],
    UNKNOWN: ["reconciliation_unparseable"],
  },
  UNKNOWN: {
    CONFIRMED: ["retrieved_success"],
    FAILED: ["retrieved_error", "proven_not_included"],
    UNKNOWN: ["recovery_inconclusive"],
  },
};

/** True only where the chain has been observed to have accepted the transaction. */
export function isOnChainSuccessConfirmed(state: TradeIntentState): boolean {
  return state === "CONFIRMED" || state === "RECONCILED";
}

/** Only a RECONCILED intent may have produced a position. Spec §5.2 rule 3. */
export function isPositionBearing(state: TradeIntentState): boolean {
  return state === "RECONCILED";
}

export interface IntentTransitionContext {
  now: number;
  /** Required when, and only when, moving to REJECTED. */
  rejectionCode?: string;
}

/** The column patch a transition implies. Undefined means "leave alone". */
export interface IntentTransitionPatch {
  state: TradeIntentState;
  confirmedAt?: number;
  reconciledAt?: number;
  submittedAt?: number;
  rejectionCode?: string;
  /** `null` means "write NULL" — spec §19, terminal states hold no signed bytes. */
  signedTxB64?: null;
}

export type IntentTransitionResult =
  | { ok: true; patch: IntentTransitionPatch }
  | { ok: false; code: "TERMINAL_STATE" | "ILLEGAL_TRANSITION" | "ILLEGAL_CAUSE" | "REJECTION_CODE_REQUIRED" };

/**
 * The only supported way an intent changes state. Refuses anything the
 * table does not draw, and — the part that matters — refuses a legal
 * state pair reached for an illegal reason.
 */
export function applyIntentTransition(
  from: TradeIntentState,
  to: TradeIntentState,
  cause: IntentTransitionCause,
  context: IntentTransitionContext,
): IntentTransitionResult {
  if (TERMINAL_INTENT_STATES.has(from)) return { ok: false, code: "TERMINAL_STATE" };

  const causes = INTENT_TRANSITIONS[from]?.[to];
  if (!causes) return { ok: false, code: "ILLEGAL_TRANSITION" };
  if (!causes.includes(cause)) return { ok: false, code: "ILLEGAL_CAUSE" };

  if (to === "REJECTED" && !context.rejectionCode) return { ok: false, code: "REJECTION_CODE_REQUIRED" };

  const patch: IntentTransitionPatch = { state: to };

  if (to === "SUBMITTED") patch.submittedAt = context.now;
  // A confirmation timestamp is only ever written by a transition into a
  // state that genuinely represents a retrieved confirmation. The
  // migration's trade_intents_confirmed_at_requires_confirmed_state CHECK
  // is the same rule, enforced by Postgres.
  if (to === "CONFIRMED") patch.confirmedAt = context.now;
  if (to === "RECONCILED") patch.reconciledAt = context.now;
  if (to === "REJECTED") patch.rejectionCode = context.rejectionCode;

  // Spec §19: signed bytes are a bearer instrument. A terminal intent must
  // not be holding any, so that no future code path can find and resubmit
  // them. The migration's CHECK constraint enforces the same.
  if (TERMINAL_INTENT_STATES.has(to)) patch.signedTxB64 = null;

  return { ok: true, patch };
}

// ── Idempotency (spec §5.4) ────────────────────────────────────────────

export interface IdempotencyKeyInput {
  accountId: string;
  mint: string;
  side: "BUY" | "SELL";
  marketObservationSlot: number;
  candidateId: string;
}

/**
 * sha256(accountId | mint | side | slot | candidateId), NUL-separated so a
 * value cannot smear across a boundary ("AB"+"C" must not collide with
 * "A"+"BC").
 *
 * DELIBERATELY takes no timestamp of any kind. Including `createdAt` would
 * make every retry unique and silently defeat the entire mechanism — the
 * classic way idempotency keys are rendered useless. The single-argument
 * signature is itself asserted by test/live-trade-intent.ts, so adding a
 * time parameter later breaks a test rather than a production invariant.
 */
export function computeIdempotencyKey(input: IdempotencyKeyInput): string {
  const parts = [
    input.accountId,
    input.mint,
    input.side,
    String(input.marketObservationSlot),
    input.candidateId,
  ];
  return createHash("sha256").update(parts.join(" "), "utf8").digest("hex");
}

// ── The engine's proposal (spec §5.1: the engine proposes, never authorizes) ──

/**
 * `.strict()` and deliberately narrow. The engine supplies market facts
 * and nothing else: no intent id (the control plane assigns it), no
 * wallet, no route, no transaction bytes, no signature. A device signature
 * on a proposal authenticates WHICH PROCESS spoke — never WHICH HUMAN —
 * because hosted tenants' device keys are server-generated (spec §1.3).
 *
 * Money fields arrive as decimal STRINGS. JSON has no bigint, and parsing
 * a lamport amount out of a JS `number` silently loses precision above
 * 2^53 — which is inside the range of real lamport values.
 */
const BigIntString = z.string().regex(/^\d+$/, "expected a non-negative integer as a decimal string");

const TradeIntentProposalObject = z.object({
  mint: z.string().min(32).max(64),
  side: z.enum(["BUY", "SELL"]),
  /** BUY only: SOL in. */
  amountLamports: BigIntString.optional(),
  /** SELL only: exact token base units out. */
  amountTokenRaw: BigIntString.optional(),
  expectedPrice: z.object({
    quoteLamports: BigIntString,
    baseUnits: BigIntString,
  }).strict(),
  strategyReason: z.string().min(1).max(512),
  marketEvidence: z.record(z.unknown()),
  /**
   * The observedAtMs of the observation this intent derives from — NOT
   * proposal time. Firewall F13 measures staleness from here, exactly as
   * evaluatePaperRisk() step 1 does, so a proposal that sat in a sync
   * queue does not look fresh.
   */
  marketObservationTimestamp: z.number().int().positive(),
  marketObservationSlot: z.number().int().positive(),
  candidateId: z.string().min(1).max(256),
}).strict();

/**
 * The field set, exported separately because `.refine()` below wraps the
 * object in a ZodEffects that has no `.shape`. The key-material schema
 * assertion (spec T48) reads this.
 */
export const TRADE_INTENT_PROPOSAL_SHAPE = TradeIntentProposalObject.shape;

export const TradeIntentProposalSchema = TradeIntentProposalObject.refine(
  (p) => (p.side === "BUY" ? p.amountLamports !== undefined && p.amountTokenRaw === undefined
    : p.amountTokenRaw !== undefined && p.amountLamports === undefined),
  { message: "BUY requires amountLamports only; SELL requires amountTokenRaw only" },
);

export type TradeIntentProposal = z.infer<typeof TradeIntentProposalSchema>;

/** The control-plane row shape, before any firewall evaluation. */
export interface TradeIntentDraft {
  userId: number;
  accountId: string;
  proposingClientId: string | null;
  wallet: string;
  riskPolicyId: string;
  consentVersion: string;
  mint: string;
  side: "BUY" | "SELL";
  amountLamports: bigint | null;
  amountTokenRaw: bigint | null;
  /** QUOTED, and typed as such — see src/live/money.ts for why that matters. */
  expectedPriceQuoteLamports: QuotedLamports;
  expectedPriceBaseUnits: bigint;
  strategyReason: string;
  marketEvidence: Record<string, unknown>;
  marketObservationTimestamp: number;
  marketObservationSlot: number;
  candidateId: string;
  state: TradeIntentState;
  createdAt: number;
  expiresAt: number;
  idempotencyKey: string;
  // Explicitly null rather than absent: a draft has no route, no bytes, no
  // signature and no outcome, and saying so in the type stops a later
  // author treating "undefined" as "not looked up yet".
  unsignedTxB64: null;
  signedTxB64: null;
  txSignature: null;
  confirmedAt: null;
  reconciledAt: null;
}

export function buildTradeIntentDraft(input: {
  proposal: TradeIntentProposal;
  userId: number;
  accountId: string;
  wallet: string;
  riskPolicyId: string;
  consentVersion: string;
  proposingClientId: string | null;
  createdAt: number;
}): TradeIntentDraft {
  const { proposal } = input;
  return {
    userId: input.userId,
    accountId: input.accountId,
    proposingClientId: input.proposingClientId,
    // Copied at creation, never joined at read time: an intent is forever
    // associated with the wallet, policy and disclosure version in force
    // when it was created, even after any of them change.
    wallet: input.wallet,
    riskPolicyId: input.riskPolicyId,
    consentVersion: input.consentVersion,
    mint: proposal.mint,
    side: proposal.side,
    amountLamports: proposal.amountLamports !== undefined ? BigInt(proposal.amountLamports) : null,
    amountTokenRaw: proposal.amountTokenRaw !== undefined ? BigInt(proposal.amountTokenRaw) : null,
    expectedPriceQuoteLamports: quotedLamports(BigInt(proposal.expectedPrice.quoteLamports)),
    expectedPriceBaseUnits: BigInt(proposal.expectedPrice.baseUnits),
    strategyReason: proposal.strategyReason,
    marketEvidence: proposal.marketEvidence,
    marketObservationTimestamp: proposal.marketObservationTimestamp,
    marketObservationSlot: proposal.marketObservationSlot,
    candidateId: proposal.candidateId,
    state: "CREATED",
    createdAt: input.createdAt,
    expiresAt: input.createdAt + LIVE_TIMING.INTENT_TTL_MS,
    idempotencyKey: computeIdempotencyKey({
      accountId: input.accountId,
      mint: proposal.mint,
      side: proposal.side,
      marketObservationSlot: proposal.marketObservationSlot,
      candidateId: proposal.candidateId,
    }),
    unsignedTxB64: null,
    signedTxB64: null,
    txSignature: null,
    confirmedAt: null,
    reconciledAt: null,
  };
}
