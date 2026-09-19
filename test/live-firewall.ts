/**
 * LIVE 0.1 §6 — the Transaction Firewall.
 *
 * RED-first. Spec test T13 requires that every gate has a test which fails
 * ONLY that gate; this file provides one per gate, built by mutating a
 * single fully-valid context so a failure can be attributed to exactly one
 * cause. T14/T15/T16 are here too: an unavailable input rejects rather
 * than passes, evidence is carried on approval as well as rejection, and
 * pass 2 re-runs everything pass 1 ran.
 *
 * It also proves the non-negotiable operational rule: a rejection is
 * LOGGED with its exact code. `recordFirewallDecision` writes an audit row
 * for every decision, approved or rejected, and this suite reads those
 * rows back out of SQLite to prove no gate failure is silently swallowed.
 *
 * Run: npx tsx test/live-firewall.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const TEST_DB = "./data/live-firewall-test.db";
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(TEST_DB + suffix)) fs.rmSync(TEST_DB + suffix);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = privJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = pubJwk.x;
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";

const {
  evaluateFirewall,
  recordFirewallDecision,
  FIREWALL_GATES,
  FIREWALL_REJECTION_CODES,
} = await import("../src/live/transaction-firewall.js");
const { realizedLamports } = await import("../src/live/money.js");
const { ALLOWED_PROGRAM_IDS, LIVE_TIMING, MAX_ORACLE_DIVERGENCE_BPS } = await import("../src/live/live-limits.js");
const { db } = await import("../src/db.js");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const NOW = 1_758_300_000_000;
const FOUNDER_TG = 8675309;
const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const WALLET = "So11111111111111111111111111111111111111112";
const MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MESSAGE_HASH = "a".repeat(64);

function policy() {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    maxTradeLamports: 10_000_000n,
    maxOpenPositions: 1,
    maxTotalExposureLamports: 10_000_000n,
    maxDailyRealizedLossLamports: 20_000_000n,
    maxSlippageBps: 300,
    maxExecutionCostLamports: 200_000n,
    maxExecutionCostBpsOfTrade: 500,
    mintCooldownSeconds: 60,
    globalCooldownSeconds: 30,
    minReserveLamports: 10_000_000n,
  };
}

/** Every gate legitimately satisfied. Each test below breaks exactly one thing. */
function validContext(overrides: Record<string, unknown> = {}) {
  return {
    pass: 1 as 1 | 2,
    now: NOW,
    globalLiveEnabled: true,
    configuredFounderTelegramIds: new Set([FOUNDER_TG]),
    intent: {
      userId: 7,
      accountId: ACCOUNT_ID,
      wallet: WALLET,
      mint: MINT,
      side: "BUY" as const,
      amountLamports: 5_000_000n,
      requestedSlippageBps: 200,
      marketObservationTimestamp: NOW - 3_000,
      consentVersion: "live-0.1-2026-09-19",
      expiresAt: NOW + 30_000,
      txMessageHashHex: MESSAGE_HASH,
    },
    account: {
      userId: 7,
      currentWalletPubkey: WALLET,
      liveEnabled: true,
      founderAllowlisted: true,
      founderTelegramUserId: FOUNDER_TG,
      derivedState: "ARMED" as const,
      armedUntil: NOW + 600_000,
      consentVersion: "live-0.1-2026-09-19",
    },
    policy: policy(),
    balance: { lamports: 50_000_000n, observedAt: NOW - 5_000 },
    openExposureLamports: 0n,
    pendingExposureLamports: 0n,
    openPositionCount: 0,
    todayRealizedPnlLamports: realizedLamports(0n, { txSignature: "seed", slot: 1 }),
    lastIntentAtForMint: NOW - 120_000,
    lastIntentAtForAccount: NOW - 120_000,
    estimatedExecutionCostLamports: 100_000n,
    accountHasUnknownIntent: false,
    duplicateIntentExists: false,
    route: { programIds: [...ALLOWED_PROGRAM_IDS].slice(0, 3), effectiveSlippageBps: 200, quotedPriceLamportsPerBaseUnit: 1_000n },
    oracle: { priceLamportsPerBaseUnit: 1_000n },
    simulation: { ok: true, err: null },
    signedMessageHashHex: MESSAGE_HASH,
    ...overrides,
  };
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Set)
      && base[k] && typeof base[k] === "object" && !(base[k] instanceof Set)
      ? deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}

function evaluate(patch: Record<string, unknown> = {}, pass: 1 | 2 = 1) {
  return evaluateFirewall(deepMerge(validContext(), { ...patch, pass }) as never);
}

// ── The happy path ──────────────────────────────────────────────────────
{
  const p1 = evaluate({}, 1);
  const p2 = evaluate({}, 2);
  check("a fully-valid context is APPROVED on pass 1", p1.approved === true);
  check("a fully-valid context is APPROVED on pass 2", p2.approved === true);
  check("approval carries the effective slippage, clamped to the policy ceiling",
    p1.approved === true && p1.effectiveSlippageBps === 200);
  check("an engine request for more slippage than the policy permits is CLAMPED to the ceiling, and the clamp is recorded",
    (() => {
      const r = evaluate({ intent: { requestedSlippageBps: 5000 } });
      return r.approved === true && r.effectiveSlippageBps === 300 && r.slippageClampedFromBps === 5000;
    })());

  check("an unclamped request records no clamp", p1.approved === true && p1.slippageClampedFromBps === null);

  // T15 from the spec's RED matrix.
  check("T15: evidence is present on APPROVAL, not only on rejection",
    p1.approved === true && p1.evidence.gateOutcomes.length > 0
    && p1.evidence.gateOutcomes.every((g: { outcome: string }) => g.outcome === "pass"));

  // T16 from the spec's RED matrix.
  check("T16: pass 2 evaluates a strict SUPERSET of the gates pass 1 evaluated", (() => {
    const g1 = new Set(p1.evidence.gateOutcomes.map((g: { id: string }) => g.id));
    const g2 = new Set(p2.evidence.gateOutcomes.map((g: { id: string }) => g.id));
    return [...g1].every((id) => g2.has(id as string)) && g2.size > g1.size;
  })());

  check("every declared gate is reachable on pass 2 with a valid context",
    p2.evidence.gateOutcomes.length === FIREWALL_GATES.length);
}

// ── T13: one test per gate, each failing ONLY that gate ─────────────────
const perGate: Array<[string, string, Record<string, unknown>]> = [
  ["F0 founder: the row is not allowlisted", "NOT_FOUNDER", { account: { founderAllowlisted: false } }],
  ["F0 founder: the telegram id is not in the configured allowlist", "NOT_FOUNDER", { configuredFounderTelegramIds: new Set([1]) }],
  ["F1 the caller does not own the account", "WRONG_USER", { intent: { userId: 8 } }],
  ["F2 the wallet was swapped after the proposal", "WRONG_WALLET", { account: { currentWalletPubkey: "3dQTr7ror2QPKQ3GbBCokJUmjErGg8kTJzdnYjNfvi3Z" } }],
  ["F3 the GLOBAL kill switch is off", "LIVE_DISABLED", { globalLiveEnabled: false }],
  ["F3 the PER-ACCOUNT kill switch is off", "LIVE_DISABLED", { account: { liveEnabled: false } }],
  ["F4 the account is not ARMED", "ACCOUNT_NOT_ARMED", { account: { derivedState: "READY" } }],
  ["F4 the arm window has expired", "ACCOUNT_NOT_ARMED", { account: { armedUntil: NOW - 1 } }],
  ["F5 the account's consent version is stale", "CONSENT_STALE", { account: { consentVersion: "live-0.0-old" } }],
  ["F5 the intent's copied consent version disagrees with the account's", "CONSENT_STALE", { intent: { consentVersion: "live-0.0-old" } }],
  ["F6 the balance cannot cover amount + cost + reserve", "INSUFFICIENT_BALANCE", { balance: { lamports: 14_000_000n, observedAt: NOW - 5_000 } }],
  ["F6 the balance observation is stale", "INSUFFICIENT_BALANCE", { balance: { lamports: 50_000_000n, observedAt: NOW - (LIVE_TIMING.ACCOUNT_BALANCE_FRESHNESS_SECONDS * 1000 + 1) } }],
  ["F7 the trade exceeds the policy ceiling", "TRADE_SIZE_EXCEEDED", { intent: { amountLamports: 10_000_001n } }],
  ["F8 open + pending exposure would exceed the ceiling", "EXPOSURE_EXCEEDED", { openExposureLamports: 6_000_000n }],
  ["F9 the open position count is already at the ceiling", "POSITION_COUNT_EXCEEDED", { openPositionCount: 1 }],
  ["F10 today's realized loss is at the daily ceiling", "DAILY_LOSS_LIMIT", { todayRealizedPnlLamports: realizedLamports(-20_000_000n, { txSignature: "s", slot: 2 }) }],
  ["F11 the per-mint cooldown has not elapsed", "MINT_COOLDOWN", { lastIntentAtForMint: NOW - 1_000 }],
  ["F12 the per-account global cooldown has not elapsed", "GLOBAL_COOLDOWN", { lastIntentAtForAccount: NOW - 1_000 }],
  ["F13 the market observation is stale", "STALE_OBSERVATION", { intent: { marketObservationTimestamp: NOW - (LIVE_TIMING.LIVE_ENTRY_FRESHNESS_SECONDS * 1000 + 1) } }],
  ["F17 the account holds an unresolved UNKNOWN intent", "ACCOUNT_HAS_UNKNOWN_INTENT", { accountHasUnknownIntent: true }],
  ["F19 the intent has expired", "INTENT_EXPIRED", { intent: { expiresAt: NOW - 1 } }],
  ["F20 an intent with this idempotency key already exists", "DUPLICATE_INTENT", { duplicateIntentExists: true }],
  ["F21 the estimated execution cost exceeds the absolute ceiling", "EXECUTION_COST_EXCEEDED", { estimatedExecutionCostLamports: 200_001n }],
  ["F21 the estimated execution cost exceeds the proportional ceiling", "EXECUTION_COST_EXCEEDED", { intent: { amountLamports: 1_000_000n }, estimatedExecutionCostLamports: 60_000n }],
];

for (const [name, code, patch] of perGate) {
  const r = evaluate(patch);
  check(`T13 ${name} → ${code}`, r.approved === false && r.code === code);
}

// Pass-2-only gates.
const perGatePass2: Array<[string, string, Record<string, unknown>]> = [
  ["F14 the route touches a program outside the allowlist", "UNSUPPORTED_ROUTE", { route: { programIds: ["EvilPr0gram1111111111111111111111111111111"] } }],
  ["F15 the route's own slippage exceeds the policy ceiling", "SLIPPAGE_EXCEEDED", { route: { effectiveSlippageBps: 301 } }],
  ["F15 the quote diverges from ARIA's independent oracle", "ORACLE_DIVERGENCE", { oracle: { priceLamportsPerBaseUnit: 1_000n + BigInt(MAX_ORACLE_DIVERGENCE_BPS) } }],
  ["F16 simulation reported an error", "SIMULATION_FAILED", { simulation: { ok: false, err: "InstructionError" } }],
  ["F18 one byte differs between the signed and the approved message", "SIGNED_BYTES_MISMATCH", { signedMessageHashHex: "b" + "a".repeat(63) }],
];

for (const [name, code, patch] of perGatePass2) {
  const r = evaluate(patch, 2);
  check(`T13 ${name} → ${code}`, r.approved === false && r.code === code);
}

// ── T14: UNCERTAIN = REJECT on every single gate ────────────────────────
{
  const uncertain: Array<[string, string, Record<string, unknown>]> = [
    ["an RPC error while fetching the balance", "INSUFFICIENT_BALANCE", { balance: null }],
    ["the account row could not be read", "NOT_FOUNDER", { account: null }],
    ["the risk policy could not be read", "INSUFFICIENT_BALANCE", { policy: null }],
    ["open exposure could not be computed", "EXPOSURE_EXCEEDED", { openExposureLamports: null }],
    ["the open position count could not be computed", "POSITION_COUNT_EXCEEDED", { openPositionCount: null }],
    ["today's realized PnL could not be computed", "DAILY_LOSS_LIMIT", { todayRealizedPnlLamports: null }],
    ["the execution cost could not be estimated", "INSUFFICIENT_BALANCE", { estimatedExecutionCostLamports: null }],
    ["the UNKNOWN-intent check could not be run", "ACCOUNT_HAS_UNKNOWN_INTENT", { accountHasUnknownIntent: null }],
    ["the duplicate check could not be run", "DUPLICATE_INTENT", { duplicateIntentExists: null }],
  ];
  for (const [name, code, patch] of uncertain) {
    const r = evaluate(patch);
    check(`T14 ${name} → ${code}, never a pass-through`,
      r.approved === false && r.code === code && r.evidence.uncertain === true);
  }

  const uncertainPass2: Array<[string, string, Record<string, unknown>]> = [
    ["the route could not be built or parsed", "UNSUPPORTED_ROUTE", { route: null }],
    ["the independent oracle had no price", "ORACLE_DIVERGENCE", { oracle: null }],
    ["simulation errored on the RPC side", "SIMULATION_FAILED", { simulation: null }],
    ["the signed message hash is missing", "SIGNED_BYTES_MISMATCH", { signedMessageHashHex: null }],
    ["the approved message hash is missing", "SIGNED_BYTES_MISMATCH", { intent: { txMessageHashHex: null } }],
  ];
  for (const [name, code, patch] of uncertainPass2) {
    const r = evaluate(patch, 2);
    check(`T14 ${name} → ${code}, never a pass-through`,
      r.approved === false && r.code === code && r.evidence.uncertain === true);
  }

  // Structural shape only — this does NOT verify fail-closed behavior.
  // Fail-closed behavior (does a gate actually reject on an uncertain
  // input?) is covered by the per-gate T14 rejection tests above, one input
  // at a time. This check only proves every declared gate has a well-formed
  // id/code/passes shape.
  check("every gate in the table has a well-formed declaration (id/code/passes shape only, NOT fail-closed behavior)",
    FIREWALL_GATES.every((g: { id: string; code: string; passes: number[] }) =>
      typeof g.id === "string" && (FIREWALL_REJECTION_CODES as readonly string[]).includes(g.code) && g.passes.length > 0));

  // D3/D1 regression: a STATIC check over the firewall's own input type,
  // the kind of check that would plausibly have caught D1 before it shipped.
  // Any field in FirewallContext (or a type it inlines) that is declared
  // OPTIONAL (`?:`) while its type also admits `| null` is exactly D1's
  // shape: "uncertain" is representable by silent omission instead of by a
  // forced explicit `null`, so a caller can skip it and the gate falls back
  // to a hardcoded default instead of rejecting. No such field should exist
  // anywhere in the firewall's input surface.
  {
    const source = fs.readFileSync("./src/live/transaction-firewall.ts", "utf8");
    const contextBlockMatch = source.match(/export interface FirewallContext \{[\s\S]*?\n\}/);
    check("FirewallContext interface block is found in source (test is not vacuous)", contextBlockMatch !== null);

    const contextBlock = contextBlockMatch ? contextBlockMatch[0] : "";
    // Strip comments so a docblock mentioning "?:" or "| null" cannot hide
    // (or fake) a violation.
    const codeOnly = contextBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const optionalNullableFields = [...codeOnly.matchAll(/^\s*(\w+)\?:\s*[^;]*\bnull\b[^;]*;/gm)].map((m) => m[1]);

    check("no field on FirewallContext is optional AND null-typed (the exact D1 shape)",
      optionalNullableFields.length === 0);
  }
}

// ── F8 counts PENDING intents, not only reconciled positions (T18) ──────
{
  const r = evaluate({ openExposureLamports: 0n, pendingExposureLamports: 6_000_000n });
  check("T18: F8 counts pending (APPROVED-or-later, non-terminal) intents as exposure",
    r.approved === false && r.code === "EXPOSURE_EXCEEDED");

  const ok = evaluate({ openExposureLamports: 0n, pendingExposureLamports: 0n });
  check("T18: zero pending exposure still approves", ok.approved === true);

  const uncertainPending = evaluate({ pendingExposureLamports: null });
  check("T18: unknown pending exposure rejects", uncertainPending.approved === false && uncertainPending.code === "EXPOSURE_EXCEEDED");
}

// ── D1 regression: pendingExposureLamports is REQUIRED, not optional ────
{
  // Compile-time half: proven by test/negative-types/required-uncertain-fields.ts
  // (compiled by the check below), which asserts that a FirewallContext
  // object literal OMITTING pendingExposureLamports entirely is a TYPE
  // ERROR — the actual fix for D1 IS the type becoming required, so this is
  // the real regression test, not a formality.
  const FIXTURE = "test/negative-types/d1-pending-exposure-required.ts";
  check("the D1 negative fixture exists", fs.existsSync(FIXTURE));

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
  check("D1: omitting pendingExposureLamports from a FirewallContext literal does NOT compile",
    compiled === false && /error TS\d+/.test(output));

  // Runtime half (defense in depth): even if someone forces an
  // omitted/undefined value through at runtime via `as any`, the gate must
  // still treat it as UNCERTAIN → REJECT, never silently default to 0n.
  const forced = { ...validContext() } as Record<string, unknown>;
  delete forced.pendingExposureLamports;
  const r = evaluateFirewall(forced as never);
  check("D1 runtime defense-in-depth: an omitted-at-runtime pendingExposureLamports rejects as EXPOSURE_EXCEEDED/uncertain, never a silent pass",
    r.approved === false && r.code === "EXPOSURE_EXCEEDED" && r.evidence.uncertain === true);
}

// ── No failed gate is ever silently swallowed ───────────────────────────
{
  const seen = new Set<string>();
  for (const [, code, patch] of [...perGate, ...perGatePass2]) {
    const decision = evaluate(patch, 2);
    recordFirewallDecision(decision, { actor: "test", intentId: "22222222-2222-2222-2222-222222222222" });
    if (decision.approved === false) seen.add(decision.code);
  }
  recordFirewallDecision(evaluate({}, 2), { actor: "test", intentId: "22222222-2222-2222-2222-222222222222" });

  const rows = db.prepare(`SELECT event, metadata FROM audit_log WHERE event LIKE 'live_firewall%'`).all() as Array<{ event: string; metadata: string }>;

  check("every firewall decision — approved AND rejected — writes an audit row",
    rows.length === perGate.length + perGatePass2.length + 1);

  check("every rejection's audit row carries its EXACT reason code", (() => {
    const logged = new Set(rows
      .filter((r) => r.event === "live_firewall_rejected")
      .map((r) => (JSON.parse(r.metadata) as { code: string }).code));
    return [...seen].every((c) => logged.has(c)) && logged.size === seen.size;
  })());

  check("an approval is logged distinguishably from a rejection",
    rows.some((r) => r.event === "live_firewall_approved"));

  check("the audit metadata carries the full gate evidence, not just the verdict", (() => {
    const row = rows.find((r) => r.event === "live_firewall_rejected");
    const meta = JSON.parse(row!.metadata) as { gateOutcomes?: unknown[] };
    return Array.isArray(meta.gateOutcomes) && meta.gateOutcomes.length > 0;
  })());

  check("no audit metadata contains a field that could carry key material",
    !rows.some((r) => /secret|private|seed|mnemonic|keypair/i.test(r.metadata)));
}

// ── The firewall is a permission gate, not a second strategy ────────────
{
  // Comments are stripped first: the claim being tested is about the CODE,
  // and the file's own docblock legitimately names the concepts it excludes.
  const source = fs.readFileSync("./src/live/transaction-firewall.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check("the firewall contains no profit, edge or win-rate reasoning (spec §5.1)",
    !/\b(profit|expectedReturn|winRate|edge|alpha|shouldBuy|isGoodTrade)\b/i.test(source));
  check("the firewall contains no signing, submission or key-handling code",
    !/\b(sign|sendRawTransaction|privateKey|seedPhrase|mnemonic|Keypair)\b/.test(source.replace(/signedMessageHashHex|SIGNED_BYTES_MISMATCH|signedTx|signature/g, "")));
}

console.log(failures === 0 ? "\n✅ live-firewall: all checks passed" : `\n❌ live-firewall: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
