/**
 * LIVE 0.1 Milestone 1 — TradeIntent state machine, idempotency key, and
 * the quoted-vs-realized money type boundary.
 *
 * RED-first. The assertions that matter most here are the STRUCTURAL ones:
 * this file proves that no transition exists which could let a future
 * author treat SUBMITTED as CONFIRMED, or a quoted amount as a realized
 * one. Those are not style rules — they are the two ways a system of this
 * shape reports money that does not exist.
 *
 * Pure, in-process, no database. Concurrency and the real UNIQUE
 * constraint are tested in test/live-schema-contract.ts against real
 * Postgres, because an application-level duplicate check is not a
 * guarantee and this suite must not pretend otherwise.
 *
 * Run: npx tsx test/live-trade-intent.ts
 */
const {
  TRADE_INTENT_STATES,
  TERMINAL_INTENT_STATES,
  INTENT_TRANSITIONS,
  applyIntentTransition,
  computeIdempotencyKey,
  isOnChainSuccessConfirmed,
  isPositionBearing,
  buildTradeIntentDraft,
  TradeIntentProposalSchema,
  TRADE_INTENT_PROPOSAL_SHAPE,
} = await import("../src/live/trade-intent.js");
const { quotedLamports, realizedLamports, isQuoted } = await import("../src/live/money.js");
const { LIVE_TIMING } = await import("../src/live/live-limits.js");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const NOW = 1_758_300_000_000;

// ── The declared state set matches the spec exactly ─────────────────────
{
  const expected = [
    "CREATED", "REJECTED", "APPROVED", "AWAITING_SIGNATURE", "SIGNED",
    "SUBMITTED", "CONFIRMED", "RECONCILED", "FAILED", "UNKNOWN", "EXPIRED",
  ];
  check("all 11 spec states are declared, and no others",
    TRADE_INTENT_STATES.length === 11 && expected.every((s) => (TRADE_INTENT_STATES as readonly string[]).includes(s)));

  check("the terminal set is exactly REJECTED/FAILED/EXPIRED/RECONCILED",
    TERMINAL_INTENT_STATES.size === 4
    && ["REJECTED", "FAILED", "EXPIRED", "RECONCILED"].every((s) => (TERMINAL_INTENT_STATES as ReadonlySet<string>).has(s)));

  check("UNKNOWN is NOT terminal — it is a state to be resolved, not an outcome",
    !(TERMINAL_INTENT_STATES as ReadonlySet<string>).has("UNKNOWN"));

  check("SUBMITTED is NOT terminal", !(TERMINAL_INTENT_STATES as ReadonlySet<string>).has("SUBMITTED"));
}

// ── Valid transitions ───────────────────────────────────────────────────
{
  const valid: Array<[string, string, string]> = [
    ["CREATED", "REJECTED", "firewall_rejected"],
    ["CREATED", "APPROVED", "firewall_approved"],
    ["CREATED", "EXPIRED", "ttl_elapsed"],
    ["APPROVED", "AWAITING_SIGNATURE", "delivered_to_client"],
    ["APPROVED", "EXPIRED", "ttl_elapsed"],
    ["AWAITING_SIGNATURE", "SIGNED", "signature_received_and_verified"],
    ["AWAITING_SIGNATURE", "EXPIRED", "ttl_elapsed"],
    ["SIGNED", "SUBMITTED", "submission_accepted"],
    ["SIGNED", "FAILED", "preflight_rejected"],
    ["SIGNED", "UNKNOWN", "submission_call_indeterminate"],
    ["SUBMITTED", "CONFIRMED", "retrieved_success"],
    ["SUBMITTED", "FAILED", "retrieved_error"],
    ["SUBMITTED", "UNKNOWN", "confirmation_deadline_elapsed"],
    ["UNKNOWN", "CONFIRMED", "retrieved_success"],
    ["UNKNOWN", "FAILED", "retrieved_error"],
    ["UNKNOWN", "FAILED", "proven_not_included"],
    ["UNKNOWN", "UNKNOWN", "recovery_inconclusive"],
    ["CONFIRMED", "RECONCILED", "reconciliation_completed"],
    ["CONFIRMED", "UNKNOWN", "reconciliation_unparseable"],
  ];
  check("every transition the spec's §5.2 diagram draws is permitted",
    valid.every(([from, to, cause]) =>
      applyIntentTransition(from as never, to as never, cause as never, { now: NOW, rejectionCode: "ACCOUNT_NOT_ARMED" }).ok === true));
}

// ── The two structural impossibilities ──────────────────────────────────
{
  // Rule 1: UNKNOWN is never collapsed into FAILED.
  const causesReachingFailed = new Set<string>();
  for (const [from, edges] of Object.entries(INTENT_TRANSITIONS as Record<string, Record<string, readonly string[]>>)) {
    for (const [to, causes] of Object.entries(edges)) {
      if (to === "FAILED") for (const c of causes) causesReachingFailed.add(`${from}:${c}`);
    }
  }
  check("FAILED is reachable ONLY by a pre-flight rejection, a RETRIEVED error, or a proof of non-inclusion",
    [...causesReachingFailed].every((k) => /(:preflight_rejected|:retrieved_error|:proven_not_included)$/.test(k)));

  check("no transition table entry reaches FAILED on any timeout/deadline/elapsed cause",
    ![...causesReachingFailed].some((k) => /timeout|deadline|elapsed|expired/i.test(k)));

  check("a confirmation deadline can ONLY produce UNKNOWN, never FAILED", (() => {
    const toUnknown = applyIntentTransition("SUBMITTED", "UNKNOWN", "confirmation_deadline_elapsed", { now: NOW });
    const toFailed = applyIntentTransition("SUBMITTED", "FAILED", "confirmation_deadline_elapsed" as never, { now: NOW });
    return toUnknown.ok === true && toFailed.ok === false && toFailed.code === "ILLEGAL_CAUSE";
  })());

  check("an indeterminate submission call can ONLY produce UNKNOWN, never FAILED", (() => {
    const bad = applyIntentTransition("SIGNED", "FAILED", "submission_call_indeterminate" as never, { now: NOW });
    return bad.ok === false && bad.code === "ILLEGAL_CAUSE";
  })());

  // Rule 2: SUBMITTED is not success, and CONFIRMED is not a position.
  check("SUBMITTED cannot jump straight to RECONCILED",
    applyIntentTransition("SUBMITTED", "RECONCILED", "reconciliation_completed", { now: NOW }).ok === false);

  check("isOnChainSuccessConfirmed is false for SUBMITTED and true only for CONFIRMED/RECONCILED",
    isOnChainSuccessConfirmed("SUBMITTED") === false
    && isOnChainSuccessConfirmed("SIGNED") === false
    && isOnChainSuccessConfirmed("UNKNOWN") === false
    && isOnChainSuccessConfirmed("CONFIRMED") === true
    && isOnChainSuccessConfirmed("RECONCILED") === true);

  check("isPositionBearing is true for RECONCILED ALONE — a CONFIRMED intent is not a position",
    TRADE_INTENT_STATES.filter((s: string) => isPositionBearing(s as never)).join() === "RECONCILED");

  check("a transition into CONFIRMED refuses to carry a confirmedAt unless it is genuinely confirmed", (() => {
    const good = applyIntentTransition("SUBMITTED", "CONFIRMED", "retrieved_success", { now: NOW });
    const submitted = applyIntentTransition("SIGNED", "SUBMITTED", "submission_accepted", { now: NOW });
    return good.ok === true && good.patch.confirmedAt === NOW
      && submitted.ok === true && submitted.patch.confirmedAt === undefined;
  })());

  check("reaching a terminal state NULLs the signed transaction bytes (spec §19)", (() => {
    const r = applyIntentTransition("SUBMITTED", "FAILED", "retrieved_error", { now: NOW });
    return r.ok === true && r.patch.signedTxB64 === null;
  })());

  check("a non-terminal transition does NOT null the signed bytes", (() => {
    const r = applyIntentTransition("SIGNED", "SUBMITTED", "submission_accepted", { now: NOW });
    return r.ok === true && r.patch.signedTxB64 === undefined;
  })());

  check("a REJECTED transition must carry a rejection code", (() => {
    const without = applyIntentTransition("CREATED", "REJECTED", "firewall_rejected", { now: NOW });
    const withCode = applyIntentTransition("CREATED", "REJECTED", "firewall_rejected", { now: NOW, rejectionCode: "ACCOUNT_NOT_ARMED" });
    return without.ok === false && without.code === "REJECTION_CODE_REQUIRED"
      && withCode.ok === true && withCode.patch.rejectionCode === "ACCOUNT_NOT_ARMED";
  })());
}

// ── Illegal transitions are refused ─────────────────────────────────────
{
  const illegal: Array<[string, string]> = [
    ["CREATED", "SIGNED"], ["CREATED", "SUBMITTED"], ["CREATED", "CONFIRMED"],
    ["APPROVED", "SUBMITTED"], ["AWAITING_SIGNATURE", "SUBMITTED"],
    ["SIGNED", "CONFIRMED"], ["SUBMITTED", "SIGNED"], ["CONFIRMED", "FAILED"],
    ["RECONCILED", "UNKNOWN"], ["FAILED", "CONFIRMED"], ["EXPIRED", "APPROVED"],
    ["REJECTED", "APPROVED"],
  ];
  check("every illegal transition is refused with ILLEGAL_TRANSITION",
    illegal.every(([from, to]) => {
      const r = applyIntentTransition(from as never, to as never, "firewall_approved" as never, { now: NOW, rejectionCode: "WRONG_USER" });
      return r.ok === false && (r.code === "ILLEGAL_TRANSITION" || r.code === "TERMINAL_STATE");
    }));

  check("no terminal state has ANY outgoing transition",
    [...TERMINAL_INTENT_STATES].every((from: string) =>
      TRADE_INTENT_STATES.every((to: string) =>
        applyIntentTransition(from as never, to as never, "retrieved_success" as never, { now: NOW }).ok === false)));
}

// ── Idempotency key (spec §5.4) ─────────────────────────────────────────
{
  const base = {
    accountId: "11111111-1111-1111-1111-111111111111",
    mint: "So11111111111111111111111111111111111111112",
    side: "BUY" as const,
    marketObservationSlot: 301_234_567,
    candidateId: "cand-abc",
  };

  // T9/T10 from the spec's RED matrix.
  check("T9: two proposals from one (account, mint, side, slot, candidate) produce byte-identical keys",
    computeIdempotencyKey(base) === computeIdempotencyKey({ ...base }));

  check("T10: the key does not vary with time — computeIdempotencyKey takes no timestamp at all",
    computeIdempotencyKey.length === 1
    && !/createdAt|now|Date\.now|timestamp/i.test(computeIdempotencyKey.toString()));

  check("the key is a 64-char lowercase sha256 hex digest", /^[0-9a-f]{64}$/.test(computeIdempotencyKey(base)));

  check("changing ANY component changes the key", (() => {
    const k = computeIdempotencyKey(base);
    return [
      { ...base, accountId: "22222222-2222-2222-2222-222222222222" },
      { ...base, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
      { ...base, side: "SELL" as const },
      { ...base, marketObservationSlot: 301_234_568 },
      { ...base, candidateId: "cand-abd" },
    ].every((v) => computeIdempotencyKey(v) !== k);
  })());

  check("field values cannot be smeared across the delimiter (NUL-separated, not concatenated)",
    computeIdempotencyKey({ ...base, mint: "AB", candidateId: "C" })
    !== computeIdempotencyKey({ ...base, mint: "A", candidateId: "BC" }));
}

// ── Quoted vs realized money (the owner's second structural requirement) ─
{
  const q = quotedLamports(12_345n);
  check("a quoted amount carries its own provenance at runtime", isQuoted(q) === true);

  check("a realized amount CANNOT be minted without landed-transaction evidence", (() => {
    try { (realizedLamports as (v: bigint, e: unknown) => unknown)(12_345n, null); return false; } catch { return true; }
  })());

  check("a realized amount cannot be minted from an empty signature", (() => {
    try { realizedLamports(1n, { txSignature: "", slot: 5 }); return false; } catch { return true; }
  })());

  check("a realized amount cannot be minted with a non-positive slot", (() => {
    try { realizedLamports(1n, { txSignature: "sig", slot: 0 }); return false; } catch { return true; }
  })());

  check("a realized amount minted from real evidence keeps its value AND its evidence", (() => {
    const r = realizedLamports(12_345n, { txSignature: "5xabc", slot: 301_234_567 });
    return r.lamports === 12_345n && r.kind === "realized"
      && r.evidence.txSignature === "5xabc" && r.evidence.slot === 301_234_567;
  })());

  check("a quoted and a realized amount are runtime-distinguishable, not just compile-time",
    q.kind === "quoted" && realizedLamports(1n, { txSignature: "s", slot: 1 }).kind === "realized");

  check("isQuoted is false for a realized amount — the two are runtime-distinguishable too",
    isQuoted(realizedLamports(1n, { txSignature: "s", slot: 1 })) === false);
}

// ── Draft construction ──────────────────────────────────────────────────
{
  const proposal = {
    mint: "So11111111111111111111111111111111111111112",
    side: "BUY" as const,
    amountLamports: "5000000",
    expectedPrice: { quoteLamports: "5000000", baseUnits: "1000000000" },
    strategyReason: "eligibility:pass|curve-priced",
    marketEvidence: { safety: "pass" },
    marketObservationTimestamp: NOW - 2_000,
    marketObservationSlot: 301_234_567,
    candidateId: "cand-abc",
  };

  check("a well-formed engine proposal parses", TradeIntentProposalSchema.safeParse(proposal).success === true);

  check("the proposal schema is strict — the engine cannot smuggle an extra field",
    TradeIntentProposalSchema.safeParse({ ...proposal, unsignedTxB64: "AAAA" }).success === false);

  // Spec §5.1: the engine proposes; it never assigns an intent id, a
  // wallet, a route, or transaction bytes.
  check("T48(intent): no proposal field name can carry key material or transaction bytes", (() => {
    const keys = Object.keys(TRADE_INTENT_PROPOSAL_SHAPE as Record<string, unknown>);
    return !keys.some((k) => /secret|private|seed|mnemonic|keypair|signedTx|unsignedTx|intentId|wallet/i.test(k));
  })());

  const draft = buildTradeIntentDraft({
    proposal: TradeIntentProposalSchema.parse(proposal),
    userId: 7,
    accountId: "11111111-1111-1111-1111-111111111111",
    wallet: "So11111111111111111111111111111111111111112",
    riskPolicyId: "33333333-3333-3333-3333-333333333333",
    consentVersion: "live-0.1-2026-09-19",
    proposingClientId: "44444444-4444-4444-4444-444444444444",
    createdAt: NOW,
  });

  check("a draft starts in CREATED", draft.state === "CREATED");
  check("a draft expires at createdAt + INTENT_TTL_MS", draft.expiresAt === NOW + LIVE_TIMING.INTENT_TTL_MS);
  check("the draft's idempotency key matches the standalone computation",
    draft.idempotencyKey === computeIdempotencyKey({
      accountId: "11111111-1111-1111-1111-111111111111",
      mint: proposal.mint, side: "BUY",
      marketObservationSlot: 301_234_567, candidateId: "cand-abc",
    }));
  check("the wallet, policy and consent version are COPIED into the draft, not referenced",
    draft.wallet === "So11111111111111111111111111111111111111112"
    && draft.riskPolicyId === "33333333-3333-3333-3333-333333333333"
    && draft.consentVersion === "live-0.1-2026-09-19");
  check("attribution is to the SIGNING client passed in, never resolved from the user (spec T45)",
    draft.proposingClientId === "44444444-4444-4444-4444-444444444444");
  check("a draft carries NO transaction bytes, no signature and no confirmation",
    draft.unsignedTxB64 === null && draft.signedTxB64 === null
    && draft.txSignature === null && draft.confirmedAt === null && draft.reconciledAt === null);
  check("a BUY draft has amountLamports and a null amountTokenRaw (matches the DB CHECK)",
    draft.amountLamports === 5_000_000n && draft.amountTokenRaw === null);
  check("the expected price is a QUOTED value, and is marked as such",
    isQuoted(draft.expectedPriceQuoteLamports) === true);
}

console.log(failures === 0 ? "\n✅ live-trade-intent: all checks passed" : `\n❌ live-trade-intent: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
