/**
 * LIVE 0.1 §2 — the TradingAccount state machine.
 *
 * The governing rule, restated from the spec because it is the entire
 * reason this module exists as a pure function: **a user cannot become
 * ARMED merely because the UI requested it.** Every transition DERIVES the
 * new state from server-side evidence. The Mini App, the bot, and any
 * future caller can only ever *request*; `requestAccountTransition` then
 * re-derives from evidence and refuses anything the evidence does not
 * support, with a specific, logged reason code.
 *
 * This module holds no database access and no I/O on purpose. Every
 * financial state transition is therefore testable as a pure function
 * against fabricated evidence (test/live-trading-account.ts), and the
 * persistence layer cannot accidentally become the place a gate is
 * decided.
 *
 * ARIA never receives, stores or handles a private key, seed phrase or any
 * wallet secret. Nothing in this file accepts one; the CONNECTED gate's
 * evidence is a *verification timestamp* produced by
 * src/live/wallet-ownership.ts, which itself only ever sees a public key
 * and a signature.
 */
import {
  CURRENT_CONSENT_VERSION,
  FOUNDING_BETA_HARD_CAPS,
  LIVE_TIMING,
  RISK_POLICY_BOUNDS,
} from "./live-limits.js";

/** Ordered lowest→highest. The order is load-bearing: `deriveAccountState` walks it. */
export const TRADING_ACCOUNT_STATES = [
  "UNCONFIGURED", "CONNECTED", "FUNDED", "READY", "ARMED", "PAUSED", "STOPPED",
] as const;
export type TradingAccountState = (typeof TRADING_ACCOUNT_STATES)[number];

/** STOPPED is terminal — spec §2.1. Recovery means a NEW account row that re-walks every gate. */
export const TERMINAL_ACCOUNT_STATES: ReadonlySet<TradingAccountState> = new Set(["STOPPED"]);

export type AccountGateCode =
  | "NO_OWNERSHIP_PROOF"
  | "BALANCE_UNOBSERVED"
  | "BALANCE_STALE"
  | "BALANCE_BELOW_MINIMUM"
  | "NOT_FOUNDER"
  | "NO_RISK_POLICY"
  | "RISK_POLICY_INVALID"
  | "CONSENT_MISSING"
  | "CONSENT_STALE"
  | "ARM_WINDOW_EXPIRED";

export type AccountTransitionRejectionCode =
  | AccountGateCode
  | "TERMINAL_STATE"
  | "ILLEGAL_TRANSITION"
  | "ARM_WINDOW_OUT_OF_BOUNDS"
  | "REASON_REQUIRED";

/** Spec §4. Immutable once referenced by an intent; "editing" inserts a new row. */
export interface LiveRiskPolicy {
  id: string;
  maxTradeLamports: bigint;
  maxOpenPositions: number;
  maxTotalExposureLamports: bigint;
  maxDailyRealizedLossLamports: bigint;
  maxSlippageBps: number;
  maxExecutionCostLamports: bigint;
  maxExecutionCostBpsOfTrade: number;
  mintCooldownSeconds: number;
  globalCooldownSeconds: number;
  minReserveLamports: bigint;
}

/**
 * Everything the state machine is allowed to reason from. Every field is
 * server-observed: there is deliberately no field here a client could
 * supply. A client-reported balance, or a client assertion that it
 * connected a wallet, is not evidence and has nowhere to go in this type.
 */
export interface AccountEvidence {
  now: number;
  /** Non-null only when src/live/wallet-ownership.ts verified a real signature. */
  ownershipProofVerifiedAt: number | null;
  /** From ARIA's own RPC at `confirmed`. null = never observed = UNCERTAIN. */
  observedBalanceLamports: bigint | null;
  balanceObservedAt: number | null;
  minFundedLamports: bigint;
  riskPolicy: LiveRiskPolicy | null;
  consentVersion: string | null;
  consentAcceptedAt: number | null;
  /** The per-row half of the founder gate. */
  founderAllowlisted: boolean;
  founderTelegramUserId: number | null;
  /** The config half of the founder gate — see src/config.ts liveRuntimeGates(). */
  configuredFounderTelegramIds: ReadonlySet<number>;
  armedUntil: number | null;
  stoppedAt: number | null;
}

export interface RiskPolicyValidation {
  valid: boolean;
  violations: string[];
}

/**
 * Spec §4. Rejects any non-positive money field, out-of-range bounds, an
 * inverted trade/exposure relationship, a policy the observed balance
 * cannot actually fund, and anything exceeding the Founding Beta hard
 * caps.
 *
 * `observedBalanceLamports === null` is a REJECTION, not a skip. A policy
 * cannot be validated against a balance nobody has observed, and
 * UNCERTAIN = REJECT is the default everywhere in LIVE.
 */
export function validateRiskPolicy(
  policy: LiveRiskPolicy,
  observedBalanceLamports: bigint | null,
): RiskPolicyValidation {
  const violations: string[] = [];

  if (policy.maxTradeLamports <= 0n) violations.push("MAX_TRADE_NOT_POSITIVE");
  if (policy.maxTotalExposureLamports <= 0n) violations.push("MAX_EXPOSURE_NOT_POSITIVE");
  if (policy.maxDailyRealizedLossLamports <= 0n) violations.push("MAX_DAILY_LOSS_NOT_POSITIVE");
  if (policy.maxExecutionCostLamports <= 0n) violations.push("MAX_EXECUTION_COST_NOT_POSITIVE");
  if (policy.minReserveLamports < 0n) violations.push("MIN_RESERVE_NEGATIVE");
  if (policy.mintCooldownSeconds < 0 || policy.globalCooldownSeconds < 0) violations.push("COOLDOWN_NEGATIVE");

  if (policy.maxSlippageBps < RISK_POLICY_BOUNDS.minSlippageBps || policy.maxSlippageBps > RISK_POLICY_BOUNDS.maxSlippageBps) {
    violations.push("SLIPPAGE_OUT_OF_RANGE");
  }
  if (policy.maxOpenPositions < RISK_POLICY_BOUNDS.minOpenPositions || policy.maxOpenPositions > RISK_POLICY_BOUNDS.maxOpenPositions) {
    violations.push("OPEN_POSITIONS_OUT_OF_RANGE");
  }
  if (
    policy.maxExecutionCostBpsOfTrade < RISK_POLICY_BOUNDS.minExecutionCostBpsOfTrade
    || policy.maxExecutionCostBpsOfTrade > RISK_POLICY_BOUNDS.maxExecutionCostBpsOfTrade
  ) {
    violations.push("EXECUTION_COST_BPS_OUT_OF_RANGE");
  }

  if (policy.maxTradeLamports > policy.maxTotalExposureLamports) violations.push("TRADE_EXCEEDS_TOTAL_EXPOSURE");

  // The Founding Beta envelope. More conservative than the cap is fine;
  // wider than it never is.
  if (
    policy.maxTradeLamports > FOUNDING_BETA_HARD_CAPS.maxTradeLamports
    || policy.maxTotalExposureLamports > FOUNDING_BETA_HARD_CAPS.maxTotalExposureLamports
    || policy.maxOpenPositions > FOUNDING_BETA_HARD_CAPS.maxOpenPositions
    || policy.maxDailyRealizedLossLamports > FOUNDING_BETA_HARD_CAPS.maxDailyRealizedLossLamports
    || policy.maxSlippageBps > FOUNDING_BETA_HARD_CAPS.maxSlippageBps
    || policy.maxExecutionCostLamports > FOUNDING_BETA_HARD_CAPS.maxExecutionCostLamports
    || policy.maxExecutionCostBpsOfTrade > FOUNDING_BETA_HARD_CAPS.maxExecutionCostBpsOfTrade
  ) {
    violations.push("EXCEEDS_FOUNDING_BETA_CAP");
  }

  // Spec §4: "a position you cannot afford to sell is not a position, it
  // is a donation." The reserve must survive the largest permitted trade.
  if (observedBalanceLamports === null) {
    violations.push("BALANCE_UNOBSERVED");
  } else if (policy.maxTradeLamports + policy.minReserveLamports > observedBalanceLamports) {
    violations.push("TRADE_PLUS_RESERVE_EXCEEDS_BALANCE");
  }

  return { valid: violations.length === 0, violations };
}

export interface DerivedAccountState {
  /** The highest state the evidence actually supports. */
  state: TradingAccountState;
  /** The first gate that stopped the ladder, or null when the ladder ran to ARMED. */
  blockedBy: AccountGateCode | null;
  /** Every gate outcome, so an approval is as auditable as a rejection. */
  gates: Array<{ gate: AccountGateCode; passed: boolean }>;
}

/**
 * The evidence ladder (spec §2.2, gates E1–E4). Walks upward and stops at
 * the first unmet gate, returning the highest state the evidence supports
 * and the exact gate that capped it.
 *
 * PAUSED and STOPPED are NOT derived — they are sticky operator/user
 * states that override derivation, handled in
 * `requestAccountTransition`. Evidence alone must never lift a pause.
 */
export function deriveAccountState(evidence: AccountEvidence): DerivedAccountState {
  const gates: Array<{ gate: AccountGateCode; passed: boolean }> = [];
  let state: TradingAccountState = "UNCONFIGURED";
  let blockedBy: AccountGateCode | null = null;

  const fail = (gate: AccountGateCode): DerivedAccountState => {
    gates.push({ gate, passed: false });
    return { state, blockedBy: gate, gates };
  };
  const pass = (gate: AccountGateCode) => gates.push({ gate, passed: true });

  // ── E1: CONNECTED ────────────────────────────────────────────────────
  if (evidence.ownershipProofVerifiedAt === null) return fail("NO_OWNERSHIP_PROOF");
  pass("NO_OWNERSHIP_PROOF");
  state = "CONNECTED";

  // ── E2: FUNDED. ARIA's own observation, within its freshness window. ──
  if (evidence.observedBalanceLamports === null || evidence.balanceObservedAt === null) return fail("BALANCE_UNOBSERVED");
  pass("BALANCE_UNOBSERVED");

  const balanceAgeMs = evidence.now - evidence.balanceObservedAt;
  if (balanceAgeMs > LIVE_TIMING.ACCOUNT_BALANCE_FRESHNESS_SECONDS * 1000 || balanceAgeMs < 0) return fail("BALANCE_STALE");
  pass("BALANCE_STALE");

  if (evidence.observedBalanceLamports < evidence.minFundedLamports) return fail("BALANCE_BELOW_MINIMUM");
  pass("BALANCE_BELOW_MINIMUM");
  state = "FUNDED";

  // ── Founder gate. BOTH halves must agree: the row must be flagged AND
  // the telegram id it names must be in the deployment's configured
  // allowlist. Neither a stray UPDATE nor a stray env var can admit
  // anybody on its own. An account with no named founder is UNCERTAIN,
  // and UNCERTAIN = REJECT. ──────────────────────────────────────────────
  if (
    !evidence.founderAllowlisted
    || evidence.founderTelegramUserId === null
    || !evidence.configuredFounderTelegramIds.has(evidence.founderTelegramUserId)
  ) {
    return fail("NOT_FOUNDER");
  }
  pass("NOT_FOUNDER");

  // ── E3: READY ────────────────────────────────────────────────────────
  if (evidence.riskPolicy === null) return fail("NO_RISK_POLICY");
  pass("NO_RISK_POLICY");

  if (!validateRiskPolicy(evidence.riskPolicy, evidence.observedBalanceLamports).valid) return fail("RISK_POLICY_INVALID");
  pass("RISK_POLICY_INVALID");

  if (evidence.consentAcceptedAt === null) return fail("CONSENT_MISSING");
  pass("CONSENT_MISSING");

  if (evidence.consentVersion !== CURRENT_CONSENT_VERSION) return fail("CONSENT_STALE");
  pass("CONSENT_STALE");
  state = "READY";

  // ── E4/E6: ARMED, and only while the arm window is open. Expiry is
  // evaluated lazily here rather than by a cron, matching the existing
  // engine_commands.expires_at discipline. ─────────────────────────────
  if (evidence.armedUntil === null || evidence.now >= evidence.armedUntil) return fail("ARM_WINDOW_EXPIRED");
  pass("ARM_WINDOW_EXPIRED");
  state = "ARMED";

  return { state, blockedBy, gates };
}

export type AccountTransitionRequest = "ARM" | "PAUSE" | "STOP" | "RECOMPUTE";

export interface AccountTransitionOptions {
  armWindowSeconds?: number;
  reason?: string;
}

export type AccountTransitionResult =
  | { ok: true; nextState: TradingAccountState; armedUntil?: number; derived: DerivedAccountState }
  | { ok: false; code: AccountTransitionRejectionCode; derived: DerivedAccountState };

/**
 * The only supported way an account changes state.
 *
 * `ARM` is the case that matters: it does NOT set ARMED. It re-derives
 * from evidence at the moment of the call and fails with the specific
 * blocking gate if the evidence supports anything less than ARMED. This is
 * the mechanism behind spec §2.2's sentence that a user cannot become
 * ARMED merely because the UI requested it.
 *
 * Every rejection carries a code and the full derivation. Nothing here
 * defaults to a soft pass; there is no branch that returns `ok: true`
 * without having re-derived.
 */
export function requestAccountTransition(
  current: TradingAccountState,
  request: AccountTransitionRequest,
  evidence: AccountEvidence,
  options: AccountTransitionOptions = {},
): AccountTransitionResult {
  const derived = deriveAccountState(evidence);

  // STOPPED is terminal. No request of any kind is honoured, including
  // another STOP — a second stop would imply the first was revocable.
  if (TERMINAL_ACCOUNT_STATES.has(current)) return { ok: false, code: "TERMINAL_STATE", derived };

  switch (request) {
    case "STOP": {
      // Allowed from every non-terminal state, and always requires a
      // recorded reason: a system that can stop itself without saying why
      // has no alarm, only a silence.
      if (!options.reason) return { ok: false, code: "REASON_REQUIRED", derived };
      return { ok: true, nextState: "STOPPED", derived };
    }

    case "PAUSE": {
      if (current !== "ARMED") return { ok: false, code: "ILLEGAL_TRANSITION", derived };
      if (!options.reason) return { ok: false, code: "REASON_REQUIRED", derived };
      return { ok: true, nextState: "PAUSED", derived };
    }

    case "ARM": {
      if (current !== "READY" && current !== "PAUSED") return { ok: false, code: "ILLEGAL_TRANSITION", derived };

      const armWindowSeconds = options.armWindowSeconds ?? LIVE_TIMING.DEFAULT_ARM_WINDOW_SECONDS;
      if (
        !Number.isInteger(armWindowSeconds)
        || armWindowSeconds < LIVE_TIMING.MIN_ARM_WINDOW_SECONDS
        || armWindowSeconds > LIVE_TIMING.MAX_ARM_WINDOW_SECONDS
      ) {
        return { ok: false, code: "ARM_WINDOW_OUT_OF_BOUNDS", derived };
      }

      // Arming is a request to open a NEW window, so the currently-stored
      // window's expiry is not itself a reason to refuse — but every other
      // gate is re-derived and must pass.
      if (derived.blockedBy !== null && derived.blockedBy !== "ARM_WINDOW_EXPIRED") {
        return { ok: false, code: derived.blockedBy, derived };
      }
      return { ok: true, nextState: "ARMED", armedUntil: evidence.now + armWindowSeconds * 1000, derived };
    }

    case "RECOMPUTE": {
      // A pause is an operator/automatic decision, not a property of the
      // evidence. Recomputation may DEMOTE an armed account, never lift a
      // pause and never promote anything INTO ARMED — arming requires a
      // fresh human ARM request, every time.
      if (current === "PAUSED") return { ok: true, nextState: "PAUSED", derived };
      const next = derived.state === "ARMED" && current !== "ARMED" ? "READY" : derived.state;
      return { ok: true, nextState: next, derived };
    }

    default: {
      // Exhaustiveness: adding a new request kind without handling it
      // above is a compile error here, not a silent fall-through to a
      // permissive default.
      const exhaustive: never = request;
      void exhaustive;
      return { ok: false, code: "ILLEGAL_TRANSITION", derived };
    }
  }
}
