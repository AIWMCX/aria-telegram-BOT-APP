/**
 * NEGATIVE TYPE FIXTURE — this file MUST NOT COMPILE.
 *
 * D1 regression, isolated to its own file. The reviewer's finding was that
 * `pendingExposureLamports` was declared OPTIONAL (`?:`) instead of
 * REQUIRED `bigint | null`, letting a caller silently OMIT it instead of
 * being forced to pass an explicit `null` for "unknown" — which fell back
 * to a hardcoded `0n` inside the gate and let the exposure ceiling fail
 * open. Making the field required is the actual fix; this fixture proves
 * the compiler now enforces it.
 *
 * Kept in its own file (not combined with the D5 fixture) so that
 * reverting ONLY the D1 fix makes ONLY this file start compiling again —
 * a shared fixture would still fail to compile on the D5 half alone and
 * give a false sense that this regression test still works.
 *
 * Compiled on purpose by test/live-firewall.ts.
 */
import type { FirewallContext } from "../../src/live/transaction-firewall.js";
import { realizedLamports } from "../../src/live/money.js";

const NOW = 1_758_300_000_000;

// CASE 1: a FirewallContext object literal that OMITS pendingExposureLamports
// entirely. Now that the field is required `bigint | null` (not `?:`), this
// must fail to compile with "missing property" — TS2741/TS2739-class errors.
export const case1: FirewallContext = {
  pass: 1,
  now: NOW,
  globalLiveEnabled: true,
  configuredFounderTelegramIds: new Set([1]),
  intent: {
    userId: 7,
    accountId: "11111111-1111-1111-1111-111111111111",
    wallet: "So11111111111111111111111111111111111111112",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    side: "BUY",
    amountLamports: 5_000_000n,
    requestedSlippageBps: 200,
    marketObservationTimestamp: NOW - 3_000,
    consentVersion: "live-0.1-2026-09-19",
    expiresAt: NOW + 30_000,
    txMessageHashHex: "a".repeat(64),
  },
  account: null,
  policy: null,
  balance: null,
  openExposureLamports: 0n,
  // pendingExposureLamports intentionally OMITTED — this is the case.
  openPositionCount: 0,
  todayRealizedPnlLamports: realizedLamports(0n, { txSignature: "seed", slot: 1 }),
  lastIntentAtForMint: null,
  lastIntentAtForAccount: null,
  estimatedExecutionCostLamports: null,
  accountHasUnknownIntent: null,
  duplicateIntentExists: null,
  route: null,
  oracle: null,
  simulation: null,
  signedMessageHashHex: null,
};
