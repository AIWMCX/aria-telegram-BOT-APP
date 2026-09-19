/**
 * LIVE 0.1 Milestone 1 — TradingAccount state machine + wallet-ownership
 * verification.
 *
 * RED-first: every assertion here was written before the module it
 * exercises existed, per the program's TDD discipline. Same conventions as
 * test/e2e.ts — pure in-process modules, no network, no database. These two
 * modules are deliberately DB-free so that every financial state transition
 * is testable as a pure function; persistence is a separate concern tested
 * in test/live-schema-contract.ts.
 *
 * Run: npx tsx test/live-trading-account.ts
 */
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const {
  deriveAccountState,
  requestAccountTransition,
  validateRiskPolicy,
  TRADING_ACCOUNT_STATES,
} = await import("../src/live/trading-account.js");
const {
  issueOwnershipChallenge,
  verifyOwnershipSignature,
  base58Decode,
  base58Encode,
  WalletOwnershipProofSubmissionSchema,
} = await import("../src/live/wallet-ownership.js");
const { CURRENT_CONSENT_VERSION, FOUNDING_BETA_HARD_CAPS, LIVE_TIMING } = await import("../src/live/live-limits.js");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const NOW = 1_758_300_000_000;
const FOUNDER_TG = 8675309;

function goodPolicy() {
  return {
    id: "00000000-0000-0000-0000-0000000000p1",
    maxTradeLamports: 10_000_000n,
    maxOpenPositions: 1,
    maxTotalExposureLamports: 10_000_000n,
    maxDailyRealizedLossLamports: 20_000_000n,
    maxSlippageBps: 300,
    maxExecutionCostLamports: 200_000n,
    maxExecutionCostBpsOfTrade: 100,
    mintCooldownSeconds: 60,
    globalCooldownSeconds: 30,
    minReserveLamports: 10_000_000n,
  };
}

/** Fully-valid evidence: every gate legitimately satisfied. */
function armableEvidence(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    ownershipProofVerifiedAt: NOW - 60_000,
    observedBalanceLamports: 50_000_000n,
    balanceObservedAt: NOW - 5_000,
    minFundedLamports: 10_000_000n,
    riskPolicy: goodPolicy(),
    consentVersion: CURRENT_CONSENT_VERSION,
    consentAcceptedAt: NOW - 120_000,
    founderAllowlisted: true,
    founderTelegramUserId: FOUNDER_TG,
    configuredFounderTelegramIds: new Set([FOUNDER_TG]),
    armedUntil: NOW + 600_000,
    stoppedAt: null,
    ...overrides,
  };
}

// ── The ladder derives, it is never asserted ────────────────────────────
{
  check("all 7 spec states are declared", TRADING_ACCOUNT_STATES.length === 7
    && TRADING_ACCOUNT_STATES[0] === "UNCONFIGURED" && TRADING_ACCOUNT_STATES[6] === "STOPPED");

  check("fully-valid evidence derives ARMED", deriveAccountState(armableEvidence()).state === "ARMED");

  check("no ownership proof → UNCONFIGURED with NO_OWNERSHIP_PROOF", (() => {
    const r = deriveAccountState(armableEvidence({ ownershipProofVerifiedAt: null }));
    return r.state === "UNCONFIGURED" && r.blockedBy === "NO_OWNERSHIP_PROOF";
  })());

  check("balance never observed → CONNECTED with BALANCE_UNOBSERVED", (() => {
    const r = deriveAccountState(armableEvidence({ observedBalanceLamports: null, balanceObservedAt: null }));
    return r.state === "CONNECTED" && r.blockedBy === "BALANCE_UNOBSERVED";
  })());

  // T1 from the spec's RED matrix.
  check("T1: stale balance observation derives CONNECTED, never ARMED", (() => {
    const stale = NOW - (LIVE_TIMING.ACCOUNT_BALANCE_FRESHNESS_SECONDS * 1000 + 1);
    const r = deriveAccountState(armableEvidence({ balanceObservedAt: stale }));
    return r.state === "CONNECTED" && r.blockedBy === "BALANCE_STALE";
  })());

  check("balance below the funding minimum → CONNECTED", (() => {
    const r = deriveAccountState(armableEvidence({ observedBalanceLamports: 9_999_999n }));
    return r.state === "CONNECTED" && r.blockedBy === "BALANCE_BELOW_MINIMUM";
  })());

  check("no risk policy → FUNDED", (() => {
    const r = deriveAccountState(armableEvidence({ riskPolicy: null }));
    return r.state === "FUNDED" && r.blockedBy === "NO_RISK_POLICY";
  })());

  check("invalid risk policy → FUNDED", (() => {
    const r = deriveAccountState(armableEvidence({ riskPolicy: { ...goodPolicy(), maxSlippageBps: 9999 } }));
    return r.state === "FUNDED" && r.blockedBy === "RISK_POLICY_INVALID";
  })());

  check("consent never accepted → FUNDED", (() => {
    const r = deriveAccountState(armableEvidence({ consentAcceptedAt: null }));
    return r.state === "FUNDED" && r.blockedBy === "CONSENT_MISSING";
  })());

  // T5 from the spec's RED matrix.
  check("T5: a superseded consent version demotes an otherwise-ARMED account to FUNDED", (() => {
    const r = deriveAccountState(armableEvidence({ consentVersion: "live-0.0-ancient" }));
    return r.state === "FUNDED" && r.blockedBy === "CONSENT_STALE";
  })());

  check("arm window expired → READY, not ARMED", (() => {
    const r = deriveAccountState(armableEvidence({ armedUntil: NOW - 1 }));
    return r.state === "READY" && r.blockedBy === "ARM_WINDOW_EXPIRED";
  })());

  check("never armed (null armed_until) → READY", (() => {
    const r = deriveAccountState(armableEvidence({ armedUntil: null }));
    return r.state === "READY" && r.blockedBy === "ARM_WINDOW_EXPIRED";
  })());
}

// ── Founder-only gating ─────────────────────────────────────────────────
{
  check("account not flagged founder_allowlisted can never derive past FUNDED", (() => {
    const r = deriveAccountState(armableEvidence({ founderAllowlisted: false }));
    return r.state === "FUNDED" && r.blockedBy === "NOT_FOUNDER";
  })());

  check("allowlisted flag alone is not enough — the telegram id must be in the config allowlist too", (() => {
    const r = deriveAccountState(armableEvidence({ configuredFounderTelegramIds: new Set([111]) }));
    return r.state === "FUNDED" && r.blockedBy === "NOT_FOUNDER";
  })());

  check("an account with no founder telegram id is NOT_FOUNDER (uncertain = reject)", (() => {
    const r = deriveAccountState(armableEvidence({ founderTelegramUserId: null }));
    return r.state === "FUNDED" && r.blockedBy === "NOT_FOUNDER";
  })());

  check("an empty configured allowlist admits nobody", (() => {
    const r = deriveAccountState(armableEvidence({ configuredFounderTelegramIds: new Set() }));
    return r.state === "FUNDED" && r.blockedBy === "NOT_FOUNDER";
  })());
}

// ── Transitions: a request is never an authorization ────────────────────
{
  check("ARM succeeds only when the evidence independently derives ARMED", (() => {
    const r = requestAccountTransition("READY", "ARM", armableEvidence({ armedUntil: null }), { armWindowSeconds: 3600 });
    return r.ok === true && r.nextState === "ARMED" && r.armedUntil === NOW + 3_600_000;
  })());

  check("ARM is REJECTED when the balance is stale, even though the UI asked for it", (() => {
    const stale = NOW - (LIVE_TIMING.ACCOUNT_BALANCE_FRESHNESS_SECONDS * 1000 + 1);
    const r = requestAccountTransition("READY", "ARM", armableEvidence({ balanceObservedAt: stale, armedUntil: null }), { armWindowSeconds: 3600 });
    return r.ok === false && r.code === "BALANCE_STALE";
  })());

  check("ARM is REJECTED for a non-founder", (() => {
    const r = requestAccountTransition("READY", "ARM", armableEvidence({ founderAllowlisted: false, armedUntil: null }), { armWindowSeconds: 3600 });
    return r.ok === false && r.code === "NOT_FOUNDER";
  })());

  check("ARM is REJECTED with a stale consent version", (() => {
    const r = requestAccountTransition("READY", "ARM", armableEvidence({ consentVersion: "old", armedUntil: null }), { armWindowSeconds: 3600 });
    return r.ok === false && r.code === "CONSENT_STALE";
  })());

  check("arm window is rejected outside its bounds (matches the DB CHECK constraint)", (() => {
    const tooLong = requestAccountTransition("READY", "ARM", armableEvidence({ armedUntil: null }), { armWindowSeconds: 86_401 });
    const tooShort = requestAccountTransition("READY", "ARM", armableEvidence({ armedUntil: null }), { armWindowSeconds: 59 });
    return tooLong.ok === false && tooLong.code === "ARM_WINDOW_OUT_OF_BOUNDS"
      && tooShort.ok === false && tooShort.code === "ARM_WINDOW_OUT_OF_BOUNDS";
  })());

  check("PAUSE from ARMED is allowed and records a reason", (() => {
    const r = requestAccountTransition("ARMED", "PAUSE", armableEvidence(), { reason: "user pause" });
    return r.ok === true && r.nextState === "PAUSED";
  })());

  check("PAUSE without a reason is refused — a silent pause hides why trading stopped", (() => {
    const r = requestAccountTransition("ARMED", "PAUSE", armableEvidence(), {});
    return r.ok === false && r.code === "REASON_REQUIRED";
  })());

  check("re-ARM from PAUSED is allowed when all evidence is still valid", (() => {
    const r = requestAccountTransition("PAUSED", "ARM", armableEvidence({ armedUntil: null }), { armWindowSeconds: 3600 });
    return r.ok === true && r.nextState === "ARMED";
  })());

  check("re-ARM from PAUSED is refused when evidence has decayed", (() => {
    const r = requestAccountTransition("PAUSED", "ARM", armableEvidence({ armedUntil: null, riskPolicy: null }), { armWindowSeconds: 3600 });
    return r.ok === false && r.code === "NO_RISK_POLICY";
  })());

  check("STOP is allowed from every non-terminal state", (() =>
    (["UNCONFIGURED", "CONNECTED", "FUNDED", "READY", "ARMED", "PAUSED"] as const).every((s) => {
      const r = requestAccountTransition(s, "STOP", armableEvidence(), { reason: "emergency" });
      return r.ok === true && r.nextState === "STOPPED";
    }))());

  check("STOP without a reason is refused", (() => {
    const r = requestAccountTransition("ARMED", "STOP", armableEvidence(), {});
    return r.ok === false && r.code === "REASON_REQUIRED";
  })());

  // T2 from the spec's RED matrix — STOPPED is terminal.
  check("T2: STOPPED has NO outgoing transition to any state", (() =>
    (["ARM", "PAUSE", "STOP", "RECOMPUTE"] as const).every((t) => {
      const r = requestAccountTransition("STOPPED", t, armableEvidence({ stoppedAt: NOW - 1000 }), { armWindowSeconds: 3600, reason: "x" });
      return r.ok === false && r.code === "TERMINAL_STATE";
    }))());

  check("RECOMPUTE returns the derived state and can demote an ARMED account", (() => {
    const r = requestAccountTransition("ARMED", "RECOMPUTE", armableEvidence({ armedUntil: NOW - 1 }), {});
    return r.ok === true && r.nextState === "READY";
  })());

  check("RECOMPUTE never promotes an account INTO ARMED — arming needs a human ARM request", (() => {
    const r = requestAccountTransition("READY", "RECOMPUTE", armableEvidence(), {});
    return r.ok === true && r.nextState === "READY";
  })());

  check("RECOMPUTE leaves a PAUSED account paused — a pause is not lifted by evidence alone", (() => {
    const r = requestAccountTransition("PAUSED", "RECOMPUTE", armableEvidence(), {});
    return r.ok === true && r.nextState === "PAUSED";
  })());
}

// ── Risk policy validation ──────────────────────────────────────────────
{
  check("a good policy validates", validateRiskPolicy(goodPolicy(), 50_000_000n).valid === true);

  // T7 from the spec's RED matrix.
  check("T7: maxTrade + minReserve > observed balance is rejected", (() => {
    const r = validateRiskPolicy({ ...goodPolicy(), maxTradeLamports: 45_000_000n, maxTotalExposureLamports: 45_000_000n }, 50_000_000n);
    return r.valid === false && r.violations.includes("TRADE_PLUS_RESERVE_EXCEEDS_BALANCE");
  })());

  check("an unobserved balance cannot validate a policy (uncertain = reject)", (() => {
    const r = validateRiskPolicy(goodPolicy(), null);
    return r.valid === false && r.violations.includes("BALANCE_UNOBSERVED");
  })());

  check("non-positive money fields are rejected", (() => {
    const r = validateRiskPolicy({ ...goodPolicy(), maxTradeLamports: 0n }, 50_000_000n);
    return r.valid === false && r.violations.includes("MAX_TRADE_NOT_POSITIVE");
  })());

  check("maxTrade > maxTotalExposure is rejected", (() => {
    const r = validateRiskPolicy({ ...goodPolicy(), maxTradeLamports: 10_000_001n }, 50_000_000n);
    return r.valid === false && r.violations.includes("TRADE_EXCEEDS_TOTAL_EXPOSURE");
  })());

  check("slippage outside [1,5000] bps is rejected", (() =>
    validateRiskPolicy({ ...goodPolicy(), maxSlippageBps: 0 }, 50_000_000n).violations.includes("SLIPPAGE_OUT_OF_RANGE")
    && validateRiskPolicy({ ...goodPolicy(), maxSlippageBps: 5001 }, 50_000_000n).violations.includes("SLIPPAGE_OUT_OF_RANGE"))());

  check("maxOpenPositions outside [1,10] is rejected", (() =>
    validateRiskPolicy({ ...goodPolicy(), maxOpenPositions: 0 }, 50_000_000n).violations.includes("OPEN_POSITIONS_OUT_OF_RANGE")
    && validateRiskPolicy({ ...goodPolicy(), maxOpenPositions: 11 }, 50_000_000n).violations.includes("OPEN_POSITIONS_OUT_OF_RANGE"))());

  check("the Founding Beta hard caps bind — a user may configure MORE conservative, never less", (() => {
    const over = validateRiskPolicy({
      ...goodPolicy(),
      maxTradeLamports: FOUNDING_BETA_HARD_CAPS.maxTradeLamports + 1n,
      maxTotalExposureLamports: FOUNDING_BETA_HARD_CAPS.maxTradeLamports + 1n,
    }, 5_000_000_000n);
    const under = validateRiskPolicy({ ...goodPolicy(), maxTradeLamports: 1_000_000n }, 50_000_000n);
    return over.valid === false && over.violations.includes("EXCEEDS_FOUNDING_BETA_CAP") && under.valid === true;
  })());

  check("every Founding Beta cap is at or below its spec §26 step-4 certification floor",
    FOUNDING_BETA_HARD_CAPS.maxTradeLamports <= 10_000_000n
    && FOUNDING_BETA_HARD_CAPS.maxOpenPositions <= 1
    && FOUNDING_BETA_HARD_CAPS.maxDailyRealizedLossLamports <= 20_000_000n
    && FOUNDING_BETA_HARD_CAPS.maxSlippageBps <= 300);
}

// ── Wallet ownership proof ──────────────────────────────────────────────
{
  // A real Ed25519 keypair standing in for the founder's wallet. The private
  // half exists ONLY inside this test process and is never handed to any
  // module under test — that is the whole point of the assertion below.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const pubkeyB58 = base58Encode(rawPub);

  check("base58 round-trips a 32-byte key", Buffer.compare(base58Decode(pubkeyB58), rawPub) === 0);

  check("base58Decode rejects a non-base58 alphabet character", (() => {
    try { base58Decode(pubkeyB58.slice(0, -1) + "0"); return false; } catch { return true; }
  })());

  const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
  const challenge = issueOwnershipChallenge({
    accountId: ACCOUNT_ID,
    solanaPubkey: pubkeyB58,
    nonce: randomBytes(24).toString("base64url"),
    issuedAt: NOW,
  });

  check("the challenge message binds the account, the pubkey and the nonce", (() =>
    challenge.message.includes(challenge.nonce)
    && challenge.message.includes(pubkeyB58)
    && challenge.message.includes("11111111-1111-1111-1111-111111111111"))());

  check("the challenge expires within the spec's 300s TTL", challenge.expiresAt === NOW + LIVE_TIMING.OWNERSHIP_NONCE_TTL_SECONDS * 1000
    && LIVE_TIMING.OWNERSHIP_NONCE_TTL_SECONDS === 300);

  const sigBytes = edSign(null, Buffer.from(challenge.message, "utf8"), privateKey);

  const freshProof = () => ({ verifiedAt: null as number | null, expiresAt: challenge.expiresAt });

  check("a genuine signature over the exact challenge verifies (base64)", verifyOwnershipSignature({
    solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
    expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
    signature: sigBytes.toString("base64"), signatureEncoding: "base64",
    storedProof: freshProof(), now: NOW,
  }).verified === true);

  check("the same signature verifies when pasted as base58 (Phantom's own output encoding)", verifyOwnershipSignature({
    solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
    expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
    signature: base58Encode(sigBytes), signatureEncoding: "base58",
    storedProof: freshProof(), now: NOW,
  }).verified === true);

  // T3 from the spec's RED matrix.
  check("T3: a signature over a DIFFERENT nonce fails verification", (() => {
    const other = issueOwnershipChallenge({
      accountId: ACCOUNT_ID, solanaPubkey: pubkeyB58,
      nonce: randomBytes(24).toString("base64url"), issuedAt: NOW,
    });
    const otherSig = edSign(null, Buffer.from(other.message, "utf8"), privateKey);
    const r = verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
      signature: otherSig.toString("base64"), signatureEncoding: "base64",
      storedProof: freshProof(), now: NOW,
    });
    return r.verified === false && r.reason === "SIGNATURE_INVALID";
  })());

  check("a signature from a DIFFERENT key fails verification", (() => {
    const { privateKey: other } = generateKeyPairSync("ed25519");
    const otherSig = edSign(null, Buffer.from(challenge.message, "utf8"), other);
    return verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
      signature: otherSig.toString("base64"), signatureEncoding: "base64",
      storedProof: freshProof(), now: NOW,
    }).verified === false;
  })());

  check("one flipped byte in the challenge fails verification", verifyOwnershipSignature({
    solanaPubkey: pubkeyB58, challengeMessage: challenge.message.replace(/.$/, "X"),
    expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
    signature: sigBytes.toString("base64"), signatureEncoding: "base64",
    storedProof: freshProof(), now: NOW,
  }).verified === false);

  check("a malformed pubkey is rejected without throwing", (() => {
    const r = verifyOwnershipSignature({
      solanaPubkey: "not-a-real-pubkey!!", challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
      signature: sigBytes.toString("base64"), signatureEncoding: "base64",
      storedProof: freshProof(), now: NOW,
    });
    return r.verified === false && r.reason === "PUBKEY_MALFORMED";
  })());

  check("a garbage signature is rejected without throwing", verifyOwnershipSignature({
    solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
    expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
    signature: "@@@not-base64@@@", signatureEncoding: "base64",
    storedProof: freshProof(), now: NOW,
  }).verified === false);

  // T4 from the spec's RED matrix — single-use nonce, checked at the pure layer.
  check("T4: an already-verified challenge is refused on a second presentation", (() => {
    const r = verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
      signature: sigBytes.toString("base64"), signatureEncoding: "base64",
      storedProof: { verifiedAt: NOW - 10, expiresAt: challenge.expiresAt }, now: NOW,
    });
    return r.verified === false && r.reason === "NONCE_ALREADY_USED";
  })());

  check("an expired challenge is refused even with a perfectly good signature", (() => {
    const r = verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: challenge.nonce,
      signature: sigBytes.toString("base64"), signatureEncoding: "base64",
      storedProof: { verifiedAt: null, expiresAt: challenge.expiresAt }, now: challenge.expiresAt + 1,
    });
    return r.verified === false && r.reason === "NONCE_EXPIRED";
  })());

  // D5 regression: replay is proven separately from expiry above. Now prove
  // the challenge BINDING itself is enforced, not just carried as free text.
  check("T-BIND-1: a challenge message missing the expected account binding is rejected", (() => {
    const r = verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: "22222222-2222-2222-2222-222222222222", expectedNonce: challenge.nonce,
      signature: sigBytes.toString("base64"), signatureEncoding: "base64",
      storedProof: freshProof(), now: NOW,
    });
    return r.verified === false && r.reason === "CHALLENGE_BINDING_MISMATCH";
  })());

  check("T-BIND-2: a challenge message that doesn't carry the expected nonce is rejected", (() => {
    const r = verifyOwnershipSignature({
      solanaPubkey: pubkeyB58, challengeMessage: challenge.message,
      expectedAccountId: ACCOUNT_ID, expectedNonce: randomBytes(24).toString("base64url"),
      signature: sigBytes.toString("base64"), signatureEncoding: "base64",
      storedProof: freshProof(), now: NOW,
    });
    return r.verified === false && r.reason === "CHALLENGE_BINDING_MISMATCH";
  })());
}

// ── D5 regression: storedProof is REQUIRED, not optional ────────────────
{
  // Compile-time half: test/negative-types/required-uncertain-fields.ts
  // (CASE 2) calls verifyOwnershipSignature omitting storedProof entirely.
  // Now that it's required (not `?:`), that must fail to compile — a
  // caller can no longer accidentally skip replay/expiry protection by
  // simply not passing the parameter.
  const FIXTURE = "test/negative-types/d5-stored-proof-required.ts";
  check("the D5 negative fixture exists", fs.existsSync(FIXTURE));

  let compiled = true;
  let output = "";
  try {
    execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--skipLibCheck", FIXTURE], { encoding: "utf8", shell: true });
  } catch (err) {
    compiled = false;
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  check("D5: omitting storedProof from verifyOwnershipSignature does NOT compile",
    compiled === false && /error TS\d+/.test(output));
}

// ── Key-custody boundary: the submission schema cannot carry a secret ────
{
  const shape = WalletOwnershipProofSubmissionSchema.shape as Record<string, unknown>;
  const keys = Object.keys(shape);

  // Spec T48. This is a structural assertion, not a code review.
  check("T48: no submission field name can carry key material", !keys.some((k) => /secret|private|seed|mnemonic|keypair|priv_?key|sk/i.test(k)));

  check("the submission schema is strict — an extra field is REJECTED, not silently ignored", (() => {
    const r = WalletOwnershipProofSubmissionSchema.safeParse({
      accountId: "11111111-1111-1111-1111-111111111111",
      solanaPubkey: "So11111111111111111111111111111111111111112",
      nonce: "abc", signature: "sig", signatureEncoding: "base64",
      privateKey: "leak-attempt",
    });
    return r.success === false;
  })());

  check("a well-formed submission parses", WalletOwnershipProofSubmissionSchema.safeParse({
    accountId: "11111111-1111-1111-1111-111111111111",
    solanaPubkey: "So11111111111111111111111111111111111111112",
    nonce: "abc", signature: "sig", signatureEncoding: "base58",
  }).success === true);
}

console.log(failures === 0 ? "\n✅ live-trading-account: all checks passed" : `\n❌ live-trading-account: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
