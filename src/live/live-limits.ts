/**
 * LIVE 0.1 — the single place every LIVE limit, cap and timing constant
 * lives, following this repo's standing `TIER_LIMITS` convention ("tier
 * caps live in ONE place; never hardcode a position cap or buy size
 * elsewhere", CLAUDE.md).
 *
 * Deliberately env-free. `src/config.ts` owns the two LIVE *runtime
 * switches* (LIVE_ENABLED, the founder allowlist) because those are
 * deployment facts; the numbers below are product facts and must be
 * identical in every environment, including tests. Keeping them out of the
 * Zod env schema also means every state-machine module here is a pure,
 * env-free import — which is what makes each financial transition testable
 * as a pure function.
 */

/**
 * Spec §3. A single monotonic string. The disclosure text itself is a
 * versioned file committed to the repo so the accepted words stay
 * recoverable from this string forever; that file is NOT created in
 * Milestone 1 because nothing serves consent yet (see the LEDGER).
 *
 * Bumping this demotes every ARMED/READY account to FUNDED on its next
 * recompute, and fails firewall gate F5 closed for any in-flight intent.
 * No migration is needed — the demotion is derived, never stored.
 */
export const CURRENT_CONSENT_VERSION = "live-0.1-2026-09-19";

/**
 * Spec §4 / §26 step 4. The server-side ceiling on every risk-policy
 * field. A founder may configure MORE conservative limits than these;
 * never less. These are the Founding Beta certification floor from spec
 * §26 step 4 — max trade 0.01 SOL, one position, 0.02 SOL daily loss,
 * 300 bps slippage — expressed as hard caps rather than defaults, so an
 * application bug cannot widen them.
 */
export const FOUNDING_BETA_HARD_CAPS = {
  maxTradeLamports: 10_000_000n,               // 0.01 SOL
  maxOpenPositions: 1,
  maxTotalExposureLamports: 10_000_000n,       // 0.01 SOL
  maxDailyRealizedLossLamports: 20_000_000n,   // 0.02 SOL
  maxSlippageBps: 300,
  maxExecutionCostLamports: 1_000_000n,        // 0.001 SOL
  maxExecutionCostBpsOfTrade: 500,
} as const;

/**
 * Spec §4 validation bounds, duplicated from the migration's
 * live_risk_policies_sane_bounds CHECK constraint on purpose: the DB
 * constraint is what holds under a direct write, this is what produces a
 * readable error before one is attempted. They must agree, and
 * test/live-schema-contract.ts asserts a policy rejected here is also
 * rejected by Postgres.
 */
export const RISK_POLICY_BOUNDS = {
  minSlippageBps: 1,
  maxSlippageBps: 5000,
  minOpenPositions: 1,
  maxOpenPositions: 10,
  minExecutionCostBpsOfTrade: 1,
  maxExecutionCostBpsOfTrade: 5000,
} as const;

export const LIVE_TIMING = {
  /** Spec §2.1 E2. An observation older than this is UNCERTAIN, and UNCERTAIN = REJECT. */
  ACCOUNT_BALANCE_FRESHNESS_SECONDS: 60,
  /**
   * Spec §6 F13. Matches aria-engine's PAPER_ENTRY_FRESHNESS_SECONDS
   * exactly, and is measured from the market OBSERVATION, never from
   * proposal time — a proposal that sat in a sync queue for 30s must not
   * look fresh.
   */
  LIVE_ENTRY_FRESHNESS_SECONDS: 10,
  /** Spec §2.6 — a single-use ownership challenge's lifetime. */
  OWNERSHIP_NONCE_TTL_SECONDS: 300,
  /** Spec §2.3. Arming is time-boxed; the DB CHECK constraint enforces the same range. */
  DEFAULT_ARM_WINDOW_SECONDS: 3600,
  MIN_ARM_WINDOW_SECONDS: 60,
  MAX_ARM_WINDOW_SECONDS: 86_400,
  /** Spec §5.3 — an intent's own lifetime, from creation. */
  INTENT_TTL_MS: 60_000,
} as const;

/**
 * Spec §7.4 — an ALLOWLIST, never a blocklist. A route touching any
 * program not named here is UNCERTAIN and therefore rejected, even if the
 * route provider considers it optimal. 0.1 trades a narrow, known
 * universe or it does not trade.
 *
 * Milestone 1 note: nothing builds a route yet, so nothing consults this
 * at runtime outside firewall gate F14's tests. It is defined here rather
 * than in the (unbuilt) route client so that the firewall — which is the
 * component that must refuse an unknown program — owns the list.
 */
export const ALLOWED_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun bonding curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",  // PumpSwap AMM
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // SPL Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "ComputeBudget111111111111111111111111111111",  // Compute Budget
  "11111111111111111111111111111111",             // System
]);

/** Spec §7.3 — the ceiling on divergence between a third-party quote and ARIA's own price. */
export const MAX_ORACLE_DIVERGENCE_BPS = 300;
