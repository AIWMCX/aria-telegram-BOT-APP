/**
 * LIVE 0.1 §6 — the Transaction Firewall.
 *
 * A permission gate, NOT a second strategy. It never decides whether a
 * trade is a good idea; it decides only whether a proposed trade is
 * permitted. There is deliberately no profit, edge, or win-rate reasoning
 * anywhere in this file, and test/live-firewall.ts asserts its absence
 * against the source text.
 *
 * Modeled on `evaluatePaperRisk`'s contract in aria-engine: a PURE
 * function that never mutates state, returning a typed decision that
 * always carries evidence — on approval as well as on rejection. That
 * discipline is why PAPER's risk decisions are auditable, and it is copied
 * here rather than reinvented.
 *
 * **UNCERTAIN = REJECT is the default for every gate.** Any input the
 * firewall cannot positively establish — an RPC call that errored, a
 * balance older than its freshness window, a route quote that failed to
 * parse, a missing field — is a rejection, never a pass-through. Every
 * gate below reads its inputs as `T | null` precisely so that "we could
 * not find out" is representable and lands on the reject branch.
 *
 * Two passes, not one (spec §6.1):
 *   - Pass 1, pre-construction: every check that does not need a route.
 *   - Pass 2, pre-submission: EVERY pass-1 check re-run, plus the
 *     route-dependent ones and the signed-bytes binding. Between the two
 *     a human tapped a button, time passed, the balance may have moved and
 *     the account may have been stopped, so a single-pass design would
 *     authorize against a world-state guaranteed to be stale.
 *
 * Milestone 1 note: nothing yet builds a route, simulates, or receives a
 * signature, so gates F14–F16 and F18 are exercised only by tests that
 * supply those inputs. They are implemented now so that the components
 * which later produce those inputs cannot be merged without a gate already
 * waiting for them.
 */
import { audit } from "../audit.js";
import { logger } from "../logger.js";
import {
  ALLOWED_PROGRAM_IDS,
  CURRENT_CONSENT_VERSION,
  LIVE_TIMING,
  MAX_ORACLE_DIVERGENCE_BPS,
} from "./live-limits.js";
import type { LiveRiskPolicy, TradingAccountState } from "./trading-account.js";
import type { RealizedLamports } from "./money.js";

export const FIREWALL_REJECTION_CODES = [
  "NOT_FOUNDER",
  "WRONG_USER",
  "WRONG_WALLET",
  "LIVE_DISABLED",
  "ACCOUNT_NOT_ARMED",
  "CONSENT_STALE",
  "INSUFFICIENT_BALANCE",
  "TRADE_SIZE_EXCEEDED",
  "EXPOSURE_EXCEEDED",
  "POSITION_COUNT_EXCEEDED",
  "DAILY_LOSS_LIMIT",
  "MINT_COOLDOWN",
  "GLOBAL_COOLDOWN",
  "STALE_OBSERVATION",
  "UNSUPPORTED_ROUTE",
  "SLIPPAGE_EXCEEDED",
  "ORACLE_DIVERGENCE",
  "SIMULATION_FAILED",
  "ACCOUNT_HAS_UNKNOWN_INTENT",
  "SIGNED_BYTES_MISMATCH",
  "INTENT_EXPIRED",
  "DUPLICATE_INTENT",
  "EXECUTION_COST_EXCEEDED",
] as const;
export type FirewallRejectionCode = (typeof FIREWALL_REJECTION_CODES)[number];

export interface FirewallIntentView {
  userId: number;
  accountId: string;
  wallet: string;
  mint: string;
  side: "BUY" | "SELL";
  /** BUY notional in lamports. SELL sizing is validated at the route layer in a later milestone. */
  amountLamports: bigint;
  requestedSlippageBps: number;
  marketObservationTimestamp: number;
  consentVersion: string;
  expiresAt: number;
  /** sha256 of the approved transaction MESSAGE. null until APPROVED. */
  txMessageHashHex: string | null;
}

export interface FirewallAccountView {
  userId: number;
  currentWalletPubkey: string;
  liveEnabled: boolean;
  founderAllowlisted: boolean;
  founderTelegramUserId: number | null;
  /** DERIVED by src/live/trading-account.ts — never a stored claim. */
  derivedState: TradingAccountState;
  armedUntil: number | null;
  consentVersion: string | null;
}

/**
 * Every `| null` below means "ARIA could not establish this", and every
 * one of them rejects. That is the type-level expression of UNCERTAIN =
 * REJECT: there is no way to pass a gate an input it could not verify,
 * because "unverified" and "verified false" land on the same branch.
 */
export interface FirewallContext {
  pass: 1 | 2;
  now: number;
  globalLiveEnabled: boolean;
  configuredFounderTelegramIds: ReadonlySet<number>;
  intent: FirewallIntentView;
  account: FirewallAccountView | null;
  policy: LiveRiskPolicy | null;
  /** From ARIA's OWN RPC at `confirmed`. Never a client-reported figure. */
  balance: { lamports: bigint; observedAt: number } | null;
  /** Reconciled, landed exposure only. */
  openExposureLamports: bigint | null;
  /** Intents at or past APPROVED in a non-terminal state — see F8's note. */
  pendingExposureLamports?: bigint | null;
  openPositionCount: number | null;
  /** Realized, never a mark or a quote — the type enforces it. */
  todayRealizedPnlLamports: RealizedLamports | null;
  lastIntentAtForMint: number | null;
  lastIntentAtForAccount: number | null;
  estimatedExecutionCostLamports: bigint | null;
  accountHasUnknownIntent: boolean | null;
  duplicateIntentExists: boolean | null;
  route: { programIds: string[]; effectiveSlippageBps: number; quotedPriceLamportsPerBaseUnit: bigint } | null;
  oracle: { priceLamportsPerBaseUnit: bigint } | null;
  simulation: { ok: boolean; err: string | null } | null;
  signedMessageHashHex: string | null;
}

type GateOutcome = "pass" | "reject" | "uncertain";

export interface FirewallGate {
  id: string;
  code: FirewallRejectionCode;
  passes: Array<1 | 2>;
  check: (ctx: FirewallContext) => GateOutcome;
}

export interface FirewallEvidence {
  pass: 1 | 2;
  evaluatedAt: number;
  gateOutcomes: Array<{ id: string; code: FirewallRejectionCode; outcome: GateOutcome }>;
  /** True when the rejection was caused by an input ARIA could not establish. */
  uncertain: boolean;
}

export type FirewallDecision =
  | {
    approved: true;
    evidence: FirewallEvidence;
    effectiveSlippageBps: number;
    /**
     * The engine's original request when it exceeded the policy ceiling
     * and was clamped, otherwise null. The clamp is spec §5.3's
     * `min(policy ceiling, engine request)`, but a silent clamp would
     * mean the trade executes under terms nobody was told about — so it
     * is surfaced here and logged by `recordFirewallDecision`.
     */
    slippageClampedFromBps: number | null;
  }
  | { approved: false; code: FirewallRejectionCode; evidence: FirewallEvidence };

const SECONDS = 1000;

/** `x ?? null` for a value that may legitimately be absent from the context object. */
function presence<T>(value: T | null | undefined): T | null {
  return value === undefined || value === null ? null : value;
}

/**
 * The gate table. Declarative on purpose: "one test per gate" and "pass 2
 * re-runs everything pass 1 ran" are both assertions over this array, not
 * over a reviewer's reading of a long if-chain.
 */
export const FIREWALL_GATES: FirewallGate[] = [
  {
    // Milestone 1's founder-only requirement. BOTH halves must agree: the
    // account row's own flag AND the deployment's configured allowlist.
    id: "F0", code: "NOT_FOUNDER", passes: [1, 2],
    check: (c) => {
      if (!c.account) return "uncertain";
      if (c.account.founderTelegramUserId === null) return "uncertain";
      return c.account.founderAllowlisted && c.configuredFounderTelegramIds.has(c.account.founderTelegramUserId)
        ? "pass" : "reject";
    },
  },
  {
    // Re-queried ownership, never trusted from the payload.
    id: "F1", code: "WRONG_USER", passes: [1, 2],
    check: (c) => (!c.account ? "uncertain" : c.account.userId === c.intent.userId ? "pass" : "reject"),
  },
  {
    // Catches a wallet swapped between proposal and signature.
    id: "F2", code: "WRONG_WALLET", passes: [1, 2],
    check: (c) => (!c.account ? "uncertain" : c.account.currentWalletPubkey === c.intent.wallet ? "pass" : "reject"),
  },
  {
    // Two independent kill switches; BOTH are required.
    id: "F3", code: "LIVE_DISABLED", passes: [1, 2],
    check: (c) => (!c.account ? "uncertain" : c.globalLiveEnabled && c.account.liveEnabled ? "pass" : "reject"),
  },
  {
    id: "F4", code: "ACCOUNT_NOT_ARMED", passes: [1, 2],
    check: (c) => {
      if (!c.account) return "uncertain";
      if (c.account.armedUntil === null) return "reject";
      return c.account.derivedState === "ARMED" && c.now < c.account.armedUntil ? "pass" : "reject";
    },
  },
  {
    // Both the account's current consent AND the version the intent copied
    // at creation must be the version in force.
    id: "F5", code: "CONSENT_STALE", passes: [1, 2],
    check: (c) => {
      if (!c.account || c.account.consentVersion === null) return "uncertain";
      return c.account.consentVersion === CURRENT_CONSENT_VERSION
        && c.intent.consentVersion === CURRENT_CONSENT_VERSION ? "pass" : "reject";
    },
  },
  {
    // A stale observation is UNCERTAIN, not a small inaccuracy.
    id: "F6", code: "INSUFFICIENT_BALANCE", passes: [1, 2],
    check: (c) => {
      if (!c.balance || !c.policy) return "uncertain";
      const age = c.now - c.balance.observedAt;
      if (age < 0 || age > LIVE_TIMING.ACCOUNT_BALANCE_FRESHNESS_SECONDS * SECONDS) return "uncertain";
      const cost = presence(c.estimatedExecutionCostLamports);
      if (cost === null) return "uncertain";
      return c.balance.lamports >= c.intent.amountLamports + cost + c.policy.minReserveLamports ? "pass" : "reject";
    },
  },
  {
    // The Founding Beta hard cap is enforced inside validateRiskPolicy, so
    // a persisted policy can never be wider than it; this gate is the
    // per-intent ceiling.
    id: "F7", code: "TRADE_SIZE_EXCEEDED", passes: [1, 2],
    check: (c) => (!c.policy ? "uncertain" : c.intent.amountLamports <= c.policy.maxTradeLamports ? "pass" : "reject"),
  },
  {
    // Exposure counts RECONCILED positions PLUS intents in any non-terminal
    // state at or past APPROVED — the LIVE analogue of PAPER's
    // pendingExposureLamports, for the identical reason: two
    // near-simultaneous intents must never both see the same headroom.
    id: "F8", code: "EXPOSURE_EXCEEDED", passes: [1, 2],
    check: (c) => {
      if (!c.policy) return "uncertain";
      const open = presence(c.openExposureLamports);
      if (open === null) return "uncertain";
      const pending = "pendingExposureLamports" in c ? presence(c.pendingExposureLamports) : 0n;
      if (pending === null) return "uncertain";
      return open + pending + c.intent.amountLamports <= c.policy.maxTotalExposureLamports ? "pass" : "reject";
    },
  },
  {
    id: "F9", code: "POSITION_COUNT_EXCEEDED", passes: [1, 2],
    check: (c) => {
      if (!c.policy) return "uncertain";
      const count = presence(c.openPositionCount);
      if (count === null) return "uncertain";
      return count < c.policy.maxOpenPositions ? "pass" : "reject";
    },
  },
  {
    // Realized PnL only. The RealizedLamports type makes it impossible to
    // pass a mark, a quote or an unrealized estimate here.
    id: "F10", code: "DAILY_LOSS_LIMIT", passes: [1, 2],
    check: (c) => {
      if (!c.policy || !c.todayRealizedPnlLamports) return "uncertain";
      return c.todayRealizedPnlLamports.lamports > -c.policy.maxDailyRealizedLossLamports ? "pass" : "reject";
    },
  },
  {
    id: "F11", code: "MINT_COOLDOWN", passes: [1, 2],
    check: (c) => {
      if (!c.policy) return "uncertain";
      // No prior intent for this mint is a genuine, established fact, not
      // an unknown — the cooldown cannot have been violated.
      if (c.lastIntentAtForMint === null) return "pass";
      return c.now - c.lastIntentAtForMint >= c.policy.mintCooldownSeconds * SECONDS ? "pass" : "reject";
    },
  },
  {
    // PAPER has no equivalent: a LIVE account can be drained by many small
    // trades on DIFFERENT mints, each inside every per-mint limit.
    id: "F12", code: "GLOBAL_COOLDOWN", passes: [1, 2],
    check: (c) => {
      if (!c.policy) return "uncertain";
      if (c.lastIntentAtForAccount === null) return "pass";
      return c.now - c.lastIntentAtForAccount >= c.policy.globalCooldownSeconds * SECONDS ? "pass" : "reject";
    },
  },
  {
    // Measured from the market OBSERVATION, never from proposal time.
    id: "F13", code: "STALE_OBSERVATION", passes: [1, 2],
    check: (c) => {
      const age = c.now - c.intent.marketObservationTimestamp;
      if (age < 0) return "uncertain"; // an observation from the future is not evidence
      return age <= LIVE_TIMING.LIVE_ENTRY_FRESHNESS_SECONDS * SECONDS ? "pass" : "reject";
    },
  },
  {
    id: "F17", code: "ACCOUNT_HAS_UNKNOWN_INTENT", passes: [1, 2],
    check: (c) => {
      const has = presence(c.accountHasUnknownIntent);
      if (has === null) return "uncertain";
      return has ? "reject" : "pass";
    },
  },
  {
    id: "F19", code: "INTENT_EXPIRED", passes: [1, 2],
    check: (c) => (c.now < c.intent.expiresAt ? "pass" : "reject"),
  },
  {
    id: "F20", code: "DUPLICATE_INTENT", passes: [1, 2],
    check: (c) => {
      const dup = presence(c.duplicateIntentExists);
      if (dup === null) return "uncertain";
      return dup ? "reject" : "pass";
    },
  },
  {
    // Absolute AND proportional, AND-ed: an absolute ceiling alone is
    // wrong for a tiny trade, a proportional one alone is wrong for a
    // large one. Whichever binds first, binds.
    id: "F21", code: "EXECUTION_COST_EXCEEDED", passes: [1, 2],
    check: (c) => {
      if (!c.policy) return "uncertain";
      const cost = presence(c.estimatedExecutionCostLamports);
      if (cost === null) return "uncertain";
      if (cost > c.policy.maxExecutionCostLamports) return "reject";
      const proportionalCeiling = (c.intent.amountLamports * BigInt(c.policy.maxExecutionCostBpsOfTrade)) / 10_000n;
      return cost <= proportionalCeiling ? "pass" : "reject";
    },
  },
  {
    // ALLOWLIST, never a blocklist. An unrecognised program is UNCERTAIN.
    id: "F14", code: "UNSUPPORTED_ROUTE", passes: [2],
    check: (c) => {
      if (!c.route || !Array.isArray(c.route.programIds) || c.route.programIds.length === 0) return "uncertain";
      return c.route.programIds.every((p) => ALLOWED_PROGRAM_IDS.has(p)) ? "pass" : "reject";
    },
  },
  {
    id: "F15a", code: "SLIPPAGE_EXCEEDED", passes: [2],
    check: (c) => {
      if (!c.policy || !c.route) return "uncertain";
      return c.route.effectiveSlippageBps <= c.policy.maxSlippageBps ? "pass" : "reject";
    },
  },
  {
    // ARIA's own independently computed price cross-examines the third
    // party's quote. This is what keeps ARIA from having only one opinion
    // about the price of a trade it is about to make.
    id: "F15b", code: "ORACLE_DIVERGENCE", passes: [2],
    check: (c) => {
      if (!c.route || !c.oracle) return "uncertain";
      if (c.oracle.priceLamportsPerBaseUnit <= 0n) return "uncertain";
      const diff = c.route.quotedPriceLamportsPerBaseUnit > c.oracle.priceLamportsPerBaseUnit
        ? c.route.quotedPriceLamportsPerBaseUnit - c.oracle.priceLamportsPerBaseUnit
        : c.oracle.priceLamportsPerBaseUnit - c.route.quotedPriceLamportsPerBaseUnit;
      const divergenceBps = (diff * 10_000n) / c.oracle.priceLamportsPerBaseUnit;
      return divergenceBps <= BigInt(MAX_ORACLE_DIVERGENCE_BPS) ? "pass" : "reject";
    },
  },
  {
    // A simulation that errors on the RPC side is UNCERTAIN, not a pass.
    id: "F16", code: "SIMULATION_FAILED", passes: [2],
    check: (c) => {
      if (!c.simulation) return "uncertain";
      return c.simulation.ok && c.simulation.err === null ? "pass" : "reject";
    },
  },
  {
    // The check that makes "no hidden mutation after approval" mechanical
    // rather than aspirational — in BOTH directions. The Mini App cannot
    // substitute bytes after the preview, and neither can ARIA.
    id: "F18", code: "SIGNED_BYTES_MISMATCH", passes: [2],
    check: (c) => {
      if (!c.signedMessageHashHex || !c.intent.txMessageHashHex) return "uncertain";
      return c.signedMessageHashHex === c.intent.txMessageHashHex ? "pass" : "reject";
    },
  },
];

/**
 * Pure. Never mutates, never performs I/O, never throws for a business
 * reason. Evaluates gates in declaration order and stops at the first
 * non-pass — the evidence records every gate reached, so an approval is as
 * auditable as a rejection.
 */
export function evaluateFirewall(context: FirewallContext): FirewallDecision {
  const gateOutcomes: FirewallEvidence["gateOutcomes"] = [];

  for (const gate of FIREWALL_GATES) {
    if (!gate.passes.includes(context.pass)) continue;

    let outcome: GateOutcome;
    try {
      outcome = gate.check(context);
    } catch {
      // A gate that threw did not establish anything. UNCERTAIN = REJECT.
      outcome = "uncertain";
    }
    gateOutcomes.push({ id: gate.id, code: gate.code, outcome });

    if (outcome !== "pass") {
      return {
        approved: false,
        code: gate.code,
        evidence: { pass: context.pass, evaluatedAt: context.now, gateOutcomes, uncertain: outcome === "uncertain" },
      };
    }
  }

  // The engine may request less slippage than the policy permits; it may
  // never request more. min(), not the engine's number.
  const policyCeiling = context.policy?.maxSlippageBps ?? 0;
  const effectiveSlippageBps = Math.min(context.intent.requestedSlippageBps, policyCeiling);

  return {
    approved: true,
    effectiveSlippageBps,
    slippageClampedFromBps: context.intent.requestedSlippageBps > policyCeiling ? context.intent.requestedSlippageBps : null,
    evidence: { pass: context.pass, evaluatedAt: context.now, gateOutcomes, uncertain: false },
  };
}

/**
 * The non-negotiable operational half of the firewall: **no failed gate is
 * ever silently swallowed.** Every decision — approved and rejected —
 * writes an `audit()` row carrying the exact rejection code and the full
 * gate evidence, following this repo's standing "every DB mutation calls
 * audit()" convention and `paper-engine.ts`'s discipline of emitting a
 * risk-evaluated event on EVERY call rather than only on rejections.
 *
 * Deliberately separate from `evaluateFirewall` so that the decision
 * itself stays pure and testable, while the recording is impossible to
 * skip by accident: a caller that forgets it produces no audit row at all,
 * which the audit sweep sees, rather than a rejection that quietly
 * vanished.
 */
export function recordFirewallDecision(
  decision: FirewallDecision,
  context: { actor: string; intentId: string },
): void {
  const event = decision.approved ? "live_firewall_approved" : "live_firewall_rejected";
  const metadata: Record<string, unknown> = {
    pass: decision.evidence.pass,
    gateOutcomes: decision.evidence.gateOutcomes,
    uncertain: decision.evidence.uncertain,
  };
  if (!decision.approved) {
    metadata.code = decision.code;
  } else {
    metadata.effectiveSlippageBps = decision.effectiveSlippageBps;
    metadata.slippageClampedFromBps = decision.slippageClampedFromBps;
  }

  audit(context.actor, event, { type: "trade_intent", id: context.intentId }, metadata);

  if (decision.approved) {
    logger.info({ intentId: context.intentId, pass: decision.evidence.pass }, "live firewall approved");
  } else {
    // warn, not debug: a rejection is an operational fact the founder
    // needs to be able to find in a log without turning on verbose mode.
    logger.warn(
      { intentId: context.intentId, pass: decision.evidence.pass, code: decision.code, uncertain: decision.evidence.uncertain },
      "live firewall REJECTED",
    );
  }
}
