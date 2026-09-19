/**
 * NEGATIVE TYPE FIXTURE — this file MUST NOT COMPILE.
 *
 * It is excluded from tsconfig.json's `include` and is compiled on purpose
 * by test/live-type-boundary.ts, which asserts that every numbered case
 * below produces a TypeScript error. If this file ever compiles cleanly,
 * the quoted-vs-realized boundary has been weakened and that test fails.
 *
 * Each case is a real mistake a future author could plausibly make while
 * building the reconciler, the preview, or a PnL report.
 */
import { quotedLamports, realizedLamports, realizedValue, quotedValue } from "../../src/live/money.js";
import type { QuotedLamports, RealizedLamports } from "../../src/live/money.js";

const quote = quotedLamports(5_000_000n);
const realized = realizedLamports(4_999_100n, { txSignature: "5xSig", slot: 301234567 });

// CASE 1: assigning a quoted estimate where a realized fact is required.
export const case1: RealizedLamports = quote;

// CASE 2: the reverse — reporting a realized fact as an estimate.
export const case2: QuotedLamports = realized;

// CASE 3: unwrapping a quote through the realized accessor.
export const case3 = realizedValue(quote);

// CASE 4: unwrapping a realized amount through the quoted accessor.
export const case4 = quotedValue(realized);

// CASE 5: minting a realized amount with no landed-transaction evidence.
// (A deliberate double-cast would of course still compile — that is an
// explicit, reviewable act, which is exactly the bar this boundary sets.)
export const case5: RealizedLamports = realizedLamports(1n);

// CASE 6: a bare bigint standing in for money.
export const case6: RealizedLamports = 123n;

// CASE 7: arithmetic across the two kinds without an explicit unwrap.
export const case7 = quote + realized;
