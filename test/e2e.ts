/**
 * Self-contained end-to-end test. Sets its own env vars (no .env needed),
 * uses a throwaway SQLite file, and exercises the real Hono `app` object
 * in-process — no network binding, no external calls that would need
 * network access (Resend/Telegram calls are fire-and-forget and fail
 * safely by design; we assert on the HTTP response, not on delivery).
 *
 * Run: npx tsx test/e2e.ts
 */
import { generateKeyPairSync } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";

const TEST_DB = "./data/e2e-test.db";
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

const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string; x: string };
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;

const { app } = await import("../src/server.js");
const { CONFIG } = await import("../src/config.js");
const { totalLeads } = await import("../src/leads.js");
const { getActiveLicenseForLead, issueLicense } = await import("../src/licenses.js");

function buildInitData(user: object): string {
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(authDate));
  const pairs = Array.from(params.keys()).sort().map((k) => `${k}=${params.get(k)}`);
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(CONFIG.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

const TEST_WALLET = "So11111111111111111111111111111111111111112";
let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

async function main() {
  const r1a = await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: "x", name: "Test User", email: "t@example.com", wallet: TEST_WALLET }),
  });
  check("malformed initData → 400 (schema layer)", r1a.status === 400);

  const forged = "user=" + encodeURIComponent(JSON.stringify({ id: 1, first_name: "Attacker" })) +
    "&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=" + "0".repeat(64);
  const r1b = await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: forged, name: "Test User", email: "t@example.com", wallet: TEST_WALLET }),
  });
  check("forged initData → 401 (HMAC layer)", r1b.status === 401);

  const validInitData = buildInitData({ id: 987654321, first_name: "Bogdan", username: "bogdan_test" });
  const r2 = await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData, name: "Bogdan Jeltov", email: "bogdan@example.com", wallet: TEST_WALLET, interest: "test" }),
  });
  const body2 = (await r2.json()) as { ok: boolean };
  check("valid signed request → 200 + license issued", r2.status === 200 && body2.ok === true);

  const license = getActiveLicenseForLead(1);
  if (license) {
    const [prefix, payloadB64, sigB64] = license.token.split(".");
    const { verify, createPublicKey } = await import("node:crypto");
    const pubKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: CONFIG.ARIA_LICENSE_PUBLIC_X }, format: "jwk" });
    const valid = verify(null, Buffer.from(payloadB64!, "utf8"), pubKey, Buffer.from(sigB64!, "base64url"));
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    check("license token format is ARIA1.<payload>.<sig>", prefix === "ARIA1");
    check("license Ed25519 signature verifies offline", valid === true);
    check("license wallet binding matches submission", payload.wallet === TEST_WALLET);
    check("license tier defaults to trial", payload.tier === "trial");
    check("free tier includes live trading (not paper-locked)", payload.features.includes("live"));
    check("free tier caps are the generous free-tier values, not the old 7-day-trial values", payload.limits.maxBuySol === 0.02 && payload.limits.maxPositions === 5);
    check("free tier duration is effectively permanent (~10y), not 7 days", (payload.exp - payload.iat) > 365 * 86400);
  } else {
    check("license was issued and retrievable", false);
  }

  let lastStatus = 0;
  for (let i = 0; i < 4; i++) {
    const initData = buildInitData({ id: 555555, first_name: "Spammer" });
    const r = await app.request("/api/submit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, name: "Spam", email: `spam${i}@example.com`, wallet: TEST_WALLET }),
    });
    lastStatus = r.status;
  }
  check("4th submission within an hour → 429 rate limited", lastStatus === 429);

  const rh = await app.request("/healthz");
  const health = (await rh.json()) as { ok: boolean; paymentsEnabled: boolean };
  check("/healthz reports ok:true", health.ok === true);
  check("/healthz reports paymentsEnabled:false (no Stripe configured)", health.paymentsEnabled === false);

  const rCheckout = await app.request("/api/checkout", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData, name: "Test User", email: "t@example.com", wallet: TEST_WALLET, tier: "standard" }),
  });
  check("checkout without Stripe configured → 503, not a crash", rCheckout.status === 503);

  // The legacy post-checkout order lookup previously accepted only a
  // client-supplied order ID and returned the full paid license token. Order
  // IDs are not authentication capabilities. The endpoint is retired: paid
  // license recovery remains available only through Telegram-authenticated
  // /api/me.
  const { createOrder, markOrderPaid } = await import("../src/orders.js");
  const { getLeadById } = await import("../src/leads.js");
  const paidOrderId = createOrder(1, "standard", 29);
  markOrderPaid(paidOrderId);
  const paidLead = getLeadById(1);
  if (!paidLead?.id) throw new Error("test setup failed: lead 1 missing");
  const paidLicense = issueLicense({ ...paidLead, id: paidLead.id }, "standard", paidOrderId);
  const rLegacyOrderLookup = await app.request(`/api/license-by-order/${paidOrderId}`);
  const legacyOrderBody = await rLegacyOrderLookup.text();
  check("legacy order lookup → 410 and never discloses a paid license token",
    rLegacyOrderLookup.status === 410 && !legacyOrderBody.includes(paidLicense.token));

  // ── /api/me — returning-user account restore (P0.2) ─────────────────────

  const rMeMissing = await app.request("/api/me");
  check("/api/me with no initData header → 400", rMeMissing.status === 400);

  const rMeForged = await app.request("/api/me", { headers: { "x-init-data": forged } });
  check("/api/me with forged initData → 401", rMeForged.status === 401);

  const brandNewUserInitData = buildInitData({ id: 424242424, first_name: "NeverSignedUp" });
  const rMeNew = await app.request("/api/me", { headers: { "x-init-data": brandNewUserInitData } });
  const bodyMeNew = (await rMeNew.json()) as { ok: boolean; hasAccount: boolean; license: unknown };
  check("/api/me for a brand-new Telegram user → 200, hasAccount:false, license:null",
    rMeNew.status === 200 && bodyMeNew.ok === true && bodyMeNew.hasAccount === false && bodyMeNew.license === null);

  // Bogdan (id 987654321, lead 1) has TWO active licenses by this point: the
  // "trial" one from the earlier /api/submit call, and the "standard" one
  // issued a few lines up by the legacy-order-lookup regression test — the
  // revoke-on-issue logic is scoped per tier (see licenses.ts), so issuing
  // "standard" does not revoke the still-active "trial" license. /api/me
  // must deterministically return the MOST RECENTLY issued active license
  // ("standard"), not an arbitrary one — this is exactly the tie-break
  // fixed in licenses.ts's activeForLeadStmt (issued_at alone has only
  // second-level granularity and was a real, reproducible source of CI
  // flakiness before that fix).
  const rMeReturning = await app.request("/api/me", { headers: { "x-init-data": validInitData } });
  const bodyMeReturning = (await rMeReturning.json()) as { ok: boolean; hasAccount: boolean; license: { id: string; token: string; tier: string } | null };
  check("/api/me for a returning user with two active licenses → deterministically returns the most recently issued one",
    rMeReturning.status === 200 && bodyMeReturning.hasAccount === true &&
    bodyMeReturning.license !== null && bodyMeReturning.license.token.startsWith("ARIA1.") &&
    bodyMeReturning.license.tier === "standard");

  // Cross-user isolation: sign up a second, distinct user and confirm each
  // user's /api/me returns ONLY their own license, never the other's.
  const userBInitData = buildInitData({ id: 111222333, first_name: "SecondUser" });
  await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: userBInitData, name: "Second User", email: "second@example.com", wallet: TEST_WALLET }),
  });
  const rMeUserB = await app.request("/api/me", { headers: { "x-init-data": userBInitData } });
  const bodyMeUserB = (await rMeUserB.json()) as { license: { id: string } | null };
  check("cross-user isolation: user B's /api/me returns a DIFFERENT license id than user A's",
    bodyMeUserB.license !== null && bodyMeReturning.license !== null && bodyMeUserB.license.id !== bodyMeReturning.license.id);

  // Duplicate-account regression: the same Telegram user signing up twice
  // with two different emails must never end up with two simultaneously
  // active licenses (found via manual audit 2026-08-14, fixed in licenses.ts).
  const dupUser = { id: 700700700, first_name: "DupUser" };
  const dupInitData1 = buildInitData(dupUser);
  await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: dupInitData1, name: "Dup User", email: "dup1@example.com", wallet: TEST_WALLET }),
  });
  const dupInitData2 = buildInitData(dupUser);
  await app.request("/api/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: dupInitData2, name: "Dup User", email: "dup2@example.com", wallet: TEST_WALLET }),
  });
  const { db: rawDb } = await import("../src/db.js");
  const dupLicenses = rawDb.prepare(
    `SELECT revoked FROM licenses WHERE lead_id IN (SELECT id FROM leads WHERE tg_user_id = ?)`,
  ).all(dupUser.id) as { revoked: number }[];
  const dupActiveCount = dupLicenses.filter((l) => l.revoked === 0).length;
  check("same Telegram user signing up with 2 different emails → only 1 active license, not 2",
    dupActiveCount === 1);
  const rMeDup = await app.request("/api/me", { headers: { "x-init-data": dupInitData2 } });
  const bodyMeDup = (await rMeDup.json()) as { license: { token: string } | null };
  check("/api/me for the duplicate-signup user returns the newest (still-active) license",
    bodyMeDup.license !== null && bodyMeDup.license.token.length > 0);

  // ── /api/auth/telegram — real users domain (FREE-1) ─────────────────────
  // No DATABASE_URL in this test environment (matches CI), so the only
  // honest thing to assert here is graceful degradation, not real Postgres
  // behavior — that needs a real Postgres instance, which this suite
  // intentionally does not stand up. See docs/ARIA_FUNDS_ARCHITECTURE_V1.md.

  const rAuthNoDb = await app.request("/api/auth/telegram", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData }),
  });
  check("/api/auth/telegram with no DATABASE_URL configured → 503, not a crash", rAuthNoDb.status === 503);

  const rAuthForged = await app.request("/api/auth/telegram", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: forged }),
  });
  check("/api/auth/telegram with forged initData → 401 (checked before the DB call)", rAuthForged.status === 401);

  const rAuthBadBody = await app.request("/api/auth/telegram", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check("/api/auth/telegram with missing initData → 400", rAuthBadBody.status === 400);

  // ── Ledger invariant — pure function, no Postgres needed, runs in CI ────
  const { validateBalancedPostings } = await import("../src/ledger.js");
  try {
    validateBalancedPostings([
      { ledgerAccountId: 1, asset: "SOL", amount: 5n, balanceField: "available" },
      { ledgerAccountId: 2, asset: "SOL", amount: -5n, balanceField: "available" },
    ]);
    check("balanced postings (sum to zero) are accepted", true);
  } catch {
    check("balanced postings (sum to zero) are accepted", false);
  }
  try {
    validateBalancedPostings([
      { ledgerAccountId: 1, asset: "SOL", amount: 5n, balanceField: "available" },
      { ledgerAccountId: 2, asset: "SOL", amount: -3n, balanceField: "available" },
    ]);
    check("unbalanced postings are rejected", false);
  } catch {
    check("unbalanced postings are rejected", true);
  }
  try {
    validateBalancedPostings([{ ledgerAccountId: 1, asset: "SOL", amount: 0n, balanceField: "available" }]);
    check("a journal entry with fewer than 2 postings is rejected", false);
  } catch {
    check("a journal entry with fewer than 2 postings is rejected", true);
  }

  // ── Device auth — pure logic, no Postgres needed, runs in CI (Task 4) ────
  const { canonicalSyncMessage, verifyDeviceSignature, isTimestampWithinReplayWindow, REPLAY_WINDOW_SECONDS } =
    await import("../src/device-auth.js");

  const { generateKeyPairSync: genEd25519, sign: signEd25519 } = await import("node:crypto");
  const { publicKey: devicePub, privateKey: devicePriv } = genEd25519("ed25519");
  const devicePubJwk = devicePub.export({ format: "jwk" }) as { x: string };

  const nowSec = Math.floor(Date.now() / 1000);
  const msg = canonicalSyncMessage("client-abc", 1, nowSec, { kind: "heartbeat" });
  check("canonicalSyncMessage is deterministic for identical inputs",
    msg === canonicalSyncMessage("client-abc", 1, nowSec, { kind: "heartbeat" }));
  check("canonicalSyncMessage differs when sequence differs",
    msg !== canonicalSyncMessage("client-abc", 2, nowSec, { kind: "heartbeat" }));

  const realSig = signEd25519(null, Buffer.from(msg, "utf8"), devicePriv).toString("base64url");
  check("a genuine Ed25519 signature over the canonical message verifies",
    verifyDeviceSignature(devicePubJwk.x, msg, realSig));
  const { publicKey: otherDevicePub } = genEd25519("ed25519");
  const otherDevicePubJwk = otherDevicePub.export({ format: "jwk" }) as { x: string };
  check("a signature verified against the WRONG public key is rejected",
    !verifyDeviceSignature(otherDevicePubJwk.x, msg, realSig));
  check("a signature over a DIFFERENT message (tampered sequence) is rejected",
    !verifyDeviceSignature(devicePubJwk.x, canonicalSyncMessage("client-abc", 2, nowSec, { kind: "heartbeat" }), realSig));
  check("garbage input never throws — verifyDeviceSignature fails closed", verifyDeviceSignature("not-a-real-key", msg, "not-a-real-sig") === false);

  check("a timestamp exactly at the boundary of the replay window is accepted",
    isTimestampWithinReplayWindow(nowSec - REPLAY_WINDOW_SECONDS, nowSec));
  check("a timestamp one second past the replay window is rejected",
    !isTimestampWithinReplayWindow(nowSec - REPLAY_WINDOW_SECONDS - 1, nowSec));

  // ── Engine pairing/sync endpoints — auth and validation paths that don't
  // require Postgres (matches CI, which has no DATABASE_URL) ───────────────

  const rPairingCodeNoDb = await app.request("/api/engine/pairing-code", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData }),
  });
  check("/api/engine/pairing-code with no DATABASE_URL → 503, not a crash", rPairingCodeNoDb.status === 503);

  const rPairingCodeForged = await app.request("/api/engine/pairing-code", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: forged }),
  });
  check("/api/engine/pairing-code with forged initData → 401 (checked before DB)", rPairingCodeForged.status === 401);

  const rPairNoDb = await app.request("/api/engine/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "x".repeat(20), devicePublicKey: devicePubJwk.x }),
  });
  check("/api/engine/pair with no DATABASE_URL → 503, not a crash", rPairNoDb.status === 503);

  const rPairBadBody = await app.request("/api/engine/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "short" }),
  });
  check("/api/engine/pair with a too-short code and missing devicePublicKey → 400", rPairBadBody.status === 400);

  const rSyncNoDb = await app.request("/api/engine/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "00000000-0000-0000-0000-000000000000", sequence: 1, timestamp: nowSec,
      payload: { kind: "heartbeat" }, signature: "x".repeat(20),
    }),
  });
  check("/api/engine/sync with no DATABASE_URL → 503, not a crash", rSyncNoDb.status === 503);

  const rSyncStaleTimestamp = await app.request("/api/engine/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "00000000-0000-0000-0000-000000000000", sequence: 1, timestamp: nowSec - REPLAY_WINDOW_SECONDS - 100,
      payload: { kind: "heartbeat" }, signature: "x".repeat(20),
    }),
  });
  check("/api/engine/sync with a timestamp outside the replay window → 401 (checked before DB)", rSyncStaleTimestamp.status === 401);

  const rSyncBadBody = await app.request("/api/engine/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "not-a-uuid", sequence: -1 }),
  });
  check("/api/engine/sync with malformed body → 400", rSyncBadBody.status === 400);

  // ── ARIAE1 entitlement issuance (Task 8) — real signing, real cross-repo verification ──
  const { issueReal1BetaEntitlementToken, REAL1_BETA_DURATION_SECONDS } = await import("../src/engine-entitlement-signer.js");

  const issued = issueReal1BetaEntitlementToken("client_test_1", "jti_test_1");
  check("issueReal1BetaEntitlementToken produces an ARIAE1-prefixed token", issued.token.startsWith("ARIAE1."));
  check("issued token's duration is exactly 7 days (REAL1_BETA_DURATION_SECONDS)",
    issued.expiresAt - issued.issuedAt === REAL1_BETA_DURATION_SECONDS && REAL1_BETA_DURATION_SECONDS === 7 * 24 * 60 * 60);

  // The actual proof this matters: aria-engine's REAL, unmodified verifier
  // (Task 2) must accept a token issued by THIS code, using ONLY the
  // public key — never importing or touching the private key from that
  // side. Sibling-repo relative import, same technique already used to
  // prove Task 4's device-auth interoperability this session.
  try {
    // tsc statically resolves dynamic import() specifiers that are string
    // literals, even inside a try/catch — CI has no sibling aria-engine
    // checkout, so a literal here would fail `tsc --noEmit` with TS2307
    // regardless of the runtime guard below. Building the specifier from a
    // non-literal expression opts it out of that static check while the
    // runtime behavior (real check locally, graceful skip in CI) is unchanged.
    const ariaEngineEntitlementModule = ["..", "..", "aria-engine", "src", "entitlement.js"].join("/");
    const { verifyEntitlement } = await import(ariaEngineEntitlementModule) as typeof import("../../aria-engine/src/entitlement.js");
    const verification = verifyEntitlement(issued.token, entPubJwk.x);
    check("aria-engine's REAL entitlement verifier (unmodified, cross-repo) accepts a token issued here",
      verification.granted === true);
    if (verification.granted) {
      check("the verified payload's scope matches real1-paper-beta", verification.payload.scope === "real1-paper-beta");
      check("the verified payload's sub matches the clientId this token was issued for", verification.payload.sub === "client_test_1");
    }

    const tamperedVerification = verifyEntitlement(issued.token, pubJwk.x); // wrong key (the LICENSE key, not the entitlement key)
    check("the same token verified against the WRONG public key is rejected", tamperedVerification.granted === false);
  } catch (err) {
    console.log("  (aria-engine sibling repo not found at ../../aria-engine — skipping cross-repo interop check)");
  }

  console.log(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} TEST(S) FAILED`} — ${totalLeads()} leads in throwaway test DB`);

  // Close the handle before deleting — node:sqlite (unlike better-sqlite3)
  // can leave the file locked on Windows if you rm while it's still open.
  const { db } = await import("../src/db.js");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch { /* best-effort cleanup, not test-critical */ }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
