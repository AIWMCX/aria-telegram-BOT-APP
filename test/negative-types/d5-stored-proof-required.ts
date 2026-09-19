/**
 * NEGATIVE TYPE FIXTURE — this file MUST NOT COMPILE.
 *
 * D5 regression, isolated to its own file (see d1-pending-exposure-required.ts
 * for why these are kept separate rather than combined).
 *
 * `verifyOwnershipSignature`'s `storedProof` parameter was OPTIONAL, and
 * omitting it skipped the single-use and TTL/expiry checks entirely. Now
 * required, so a caller cannot accidentally bypass replay/expiry protection
 * by simply not passing the argument.
 *
 * Compiled on purpose by test/live-trading-account.ts.
 */
import { verifyOwnershipSignature } from "../../src/live/wallet-ownership.js";

// CASE 2: calling verifyOwnershipSignature WITHOUT storedProof — now REQUIRED
// (not `?:`), so omitting it entirely must fail to compile.
export const case2 = verifyOwnershipSignature({
  solanaPubkey: "So11111111111111111111111111111111111111112",
  challengeMessage: "irrelevant",
  expectedAccountId: "11111111-1111-1111-1111-111111111111",
  expectedNonce: "irrelevant",
  signature: "irrelevant",
  signatureEncoding: "base64",
  // storedProof intentionally OMITTED — this is the case.
});
