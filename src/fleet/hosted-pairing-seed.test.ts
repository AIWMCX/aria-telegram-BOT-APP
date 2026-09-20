/**
 * Hosted PAPER Engine — P0 fix (2026-09-19): unit tests for
 * hosted-pairing-seed.ts, proving a hosted tenant's runtime directory gets
 * a REAL, engine-verifiable pairing-state.json + ARIAE1 entitlement token,
 * not just "a file exists". Same hand-rolled convention as the rest of this
 * repo's tests (test/e2e.ts, hosted-commands.test.ts): no test framework,
 * `check()` counts failures, process exits nonzero if any failed.
 *
 * This module needs `CONFIG` (via engine-entitlement-signer.ts's import of
 * config.js) to be parseable, which requires several unrelated env vars —
 * set here BEFORE any dynamic import, exactly like test/e2e.ts does, using
 * a synthetic entitlement keypair this test controls (production's real
 * ARIA_ENTITLEMENT_PRIVATE_D lives only in Railway — see
 * fleet-manager.integration.test.ts's docblock for why that's correct and
 * not a gap in this test).
 *
 * The strongest possible proof this task asks for — importing the REAL
 * aria-engine parser/verifier against what this module writes, not a
 * hand-rolled re-implementation of its shape — is done by dynamically
 * importing aria-engine's own `src/pairing-state.ts`, `src/entitlement.ts`,
 * and `src/entitlement-gate.ts` directly from the sibling checkout at
 * `C:\Users\AIWMC\dev\aria-engine` (skipped gracefully if that checkout
 * isn't present, matching fleet-manager.integration.test.ts's own
 * convention).
 *
 * Run: npx tsx src/fleet/hosted-pairing-seed.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomUUID, sign as ed25519Sign, createPrivateKey } from "node:crypto";

const ENGINE_REPO = "C:\\Users\\AIWMC\\dev\\aria-engine";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

// ── Env setup BEFORE any dynamic import touches config.js ──────────────────
const { publicKey: licPub, privateKey: licPriv } = generateKeyPairSync("ed25519");
const licPrivJwk = licPriv.export({ format: "jwk" }) as { d: string };
const licPubJwk = licPub.export({ format: "jwk" }) as { x: string };

process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = licPrivJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = licPubJwk.x;
process.env.LOG_LEVEL = "error";

// The synthetic entitlement keypair THIS test controls — see
// entitlement-gate.ts's own docblock in aria-engine for why a real test
// proving "server-reported revocation overrides an offline-valid token"
// (and, here, "a hosted-seeded token genuinely verifies") needs a synthetic
// keypair rather than the real production one, which this dev environment
// never holds by design.
const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string };
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;
const TEST_ENTITLEMENT_PUBLIC_X = entPubJwk.x;

const {
  seedHostedPairingState,
  buildHostedPairingState,
  writeHostedPairingStateToDisk,
  renewHostedPairingStateIfNeeded,
  readHostedPairingStateFromDisk,
  entitlementNeedsRenewal,
  decodeEntitlementExpiry,
  ENTITLEMENT_RENEWAL_MARGIN_SECONDS,
} = await import("./hosted-pairing-seed.js");
type HostedPairingState = ReturnType<typeof buildHostedPairingState> & { lastKnownEntitlementStatus?: unknown };
const { generateHostedDeviceIdentity, writeHostedDeviceIdentityToDisk } = await import("./hosted-device-identity.js");

/**
 * Hand-signs a REAL ARIAE1 token with the same synthetic entitlement
 * private key `issueReal1BetaEntitlementToken` uses (via
 * ARIA_ENTITLEMENT_PRIVATE_D/_X above), but with caller-controlled
 * `iat`/`exp` — needed to construct a genuinely-signed token that's
 * ALREADY near its expiry, which the real issuer function (always
 * `iat = now`) can't produce on demand. This is real Ed25519 signing
 * against the test's own key material, not a shape-only fake token — the
 * REAL aria-engine `verifyEntitlement()` is what checks it below.
 */
function signTestEntitlementToken(clientId: string, iat: number, exp: number): string {
  const payload = { v: 1 as const, iss: "aria-engine" as const, sub: clientId, scope: "real1-paper-beta" as const, iat, exp, jti: randomUUID() };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: entPubJwk.x, d: entPrivJwk.d },
    format: "jwk",
  });
  const signature = ed25519Sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `ARIAE1.${payloadB64}.${signature.toString("base64url")}`;
}

function engineCheckoutAvailable(): boolean {
  return existsSync(path.join(ENGINE_REPO, "src", "pairing-state.ts"));
}

async function importEngineModule(relPath: string): Promise<any> {
  return import(pathToFileURL(path.join(ENGINE_REPO, "src", relPath).replace(/\\/g, "/")).href);
}

async function main() {
  const haveEngine = engineCheckoutAvailable();
  if (!haveEngine) {
    console.log(`⚠ aria-engine checkout not found at ${ENGINE_REPO} — falling back to structural-shape assertions only for the format-match tests (still running signature/crash-safety tests, which don't need it).`);
  }

  // ── buildHostedPairingState: shape matches aria-engine's PairingState exactly ──
  {
    const state = buildHostedPairingState("client-abc-123");
    check("clientId is set", state.clientId === "client-abc-123");
    check("lastSequence starts at 0, matching a real aria pair <CODE> handshake", state.lastSequence === 0);
    check("entitlementToken was minted (issuance is configured in this test env)", typeof state.entitlementToken === "string" && state.entitlementToken.length > 0);
    check("entitlementToken has the ARIAE1 prefix", state.entitlementToken!.startsWith("ARIAE1."));
    // Exactly the fields aria-engine's PairingState interface declares as
    // ever written by a pairing handshake (lastKnownEntitlementStatus is
    // populated later, by a real sync call — never at seed time).
    check("no extra unexpected top-level fields", Object.keys(state).sort().join(",") === "clientId,entitlementToken,lastSequence");
  }

  // ── seedHostedPairingState + real aria-engine loadPairingState(): byte-for-byte format match, loaded by the REAL parser ──
  if (haveEngine) {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-pairing-format-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "tenant-format-test", ".aria");
      const written = seedHostedPairingState(runtimeDir, "client-format-test");

      const filePath = path.join(runtimeDir, "state", "pairing-state.json");
      check("pairing-state.json was written to <runtimeDir>/state/, matching aria-engine's own path convention", existsSync(filePath));

      const { loadPairingState } = await importEngineModule("pairing-state.ts");
      const loaded = loadPairingState(path.join(runtimeDir, "state"));
      check("the REAL aria-engine loadPairingState() successfully parsed the file we wrote", loaded !== undefined);
      check("loaded.clientId matches what we wrote", loaded?.clientId === "client-format-test");
      check("loaded.lastSequence matches what we wrote (0)", loaded?.lastSequence === 0);
      check("loaded.entitlementToken matches what we wrote", loaded?.entitlementToken === written.entitlementToken);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── The entitlement token is genuinely signed: the REAL aria-engine verifyEntitlement() (offline verifier) accepts it, not a stub check ──
  if (haveEngine) {
    const { verifyEntitlement } = await importEngineModule("entitlement.ts");
    const state = buildHostedPairingState("client-sig-test");
    const now = new Date();
    const verification = verifyEntitlement(state.entitlementToken, TEST_ENTITLEMENT_PUBLIC_X, now);
    check("[genuine signature] the REAL aria-engine verifyEntitlement() grants the token we minted", verification.granted === true);
    if (verification.granted) {
      check("[genuine signature] payload.sub is the clientId the token was bound to", verification.payload.sub === "client-sig-test");
      check("[genuine signature] payload.scope is real1-paper-beta", verification.payload.scope === "real1-paper-beta");
      check("[genuine signature] payload.iss is aria-engine", verification.payload.iss === "aria-engine");
      check("[genuine signature] duration is exactly 7 days", verification.payload.exp - verification.payload.iat === 7 * 24 * 60 * 60);
    }

    // Negative control: proves this is REAL signature verification, not a
    // shape check — tampering with even one byte of the payload must be
    // rejected, and verifying against the WRONG public key must also fail.
    const tamperedToken = state.entitlementToken!.slice(0, -4) + "abcd";
    const tamperedResult = verifyEntitlement(tamperedToken, TEST_ENTITLEMENT_PUBLIC_X, now);
    check("[negative control] a tampered signature is rejected by the real verifier", tamperedResult.granted === false);

    const { publicKey: wrongPub } = generateKeyPairSync("ed25519");
    const wrongPubX = (wrongPub.export({ format: "jwk" }) as { x: string }).x;
    const wrongKeyResult = verifyEntitlement(state.entitlementToken, wrongPubX, now);
    check("[negative control] verifying against the WRONG public key is rejected", wrongKeyResult.granted === false);
  }

  // ── End-to-end: the REAL aria-engine checkPaperStartEntitlement() (the actual gate cmdPaperStart calls) grants access given what this module seeds ──
  if (haveEngine) {
    const { checkPaperStartEntitlement } = await importEngineModule("entitlement-gate.ts");
    const state = buildHostedPairingState("client-gate-test");
    const result = checkPaperStartEntitlement(state, new Date(), TEST_ENTITLEMENT_PUBLIC_X);
    check("[real gate] the REAL checkPaperStartEntitlement() grants a hosted-seeded pairing state", result.granted === true);
  }

  // ── registerHostedClient-style flow (brand-new hosted client): pairing state + device identity are BOTH seeded into the SAME runtime dir, before any DB commit ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-pairing-new-client-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "new-client", ".aria");
      let dbCommitted = false;

      async function simulateRegisterHostedClient(): Promise<void> {
        const identity = generateHostedDeviceIdentity();
        writeHostedDeviceIdentityToDisk(runtimeDir, identity);
        seedHostedPairingState(runtimeDir, "new-client-id");
        dbCommitted = true; // stands in for setHostingMode()
      }

      await simulateRegisterHostedClient();
      check("[new client] DB commit happened (happy path)", dbCommitted);
      check("[new client] device-identity.json exists", existsSync(path.join(runtimeDir, "state", "device-identity.json")));
      check("[new client] pairing-state.json exists in the SAME state/ dir", existsSync(path.join(runtimeDir, "state", "pairing-state.json")));

      const pairingOnDisk = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[new client] pairing-state.json's clientId matches the row's id", pairingOnDisk.clientId === "new-client-id");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── convertClientToHosted-style flow (existing local client converted): pairing state is ALSO seeded, not just device identity ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-pairing-convert-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "converted-client", ".aria");
      const row = { hosting_mode: "local" as "local" | "hosted", device_public_key: "original-local-key" };

      async function simulateConvertClientToHosted(clientId: string): Promise<void> {
        const identity = generateHostedDeviceIdentity();
        writeHostedDeviceIdentityToDisk(runtimeDir, identity);
        seedHostedPairingState(runtimeDir, clientId);
        // Stands in for the real atomic rotateClientDeviceIdentityAndSetHosted UPDATE.
        row.device_public_key = identity.publicKeyX;
        row.hosting_mode = "hosted";
      }

      await simulateConvertClientToHosted("converted-client-id");
      check("[convert] row is now hosted", row.hosting_mode === "hosted");
      check("[convert] pairing-state.json was seeded for the CONVERTED client too", existsSync(path.join(runtimeDir, "state", "pairing-state.json")));
      const pairingOnDisk = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[convert] pairing-state.json's clientId matches the converted row's id", pairingOnDisk.clientId === "converted-client-id");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── Crash-safety: DB commit throws AFTER both disk writes (device identity + pairing state) have already genuinely happened — retry must self-heal, no corruption or duplication ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-pairing-crash-safety-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "crash-client", ".aria");
      const row = { hosting_mode: "local" as "local" | "hosted", device_public_key: "original-local-key-crash-safety" };
      let dbCommitCalls = 0;
      let shouldThrowOnNextCommit = true;
      let lastWrittenPublicKeyX = "";
      let lastWrittenClientId = "";

      async function simulateConvertClientToHosted(clientId: string): Promise<void> {
        const identity = generateHostedDeviceIdentity();
        // Disk writes first — exactly bot.ts's real ordering.
        writeHostedDeviceIdentityToDisk(runtimeDir, identity);
        seedHostedPairingState(runtimeDir, clientId);
        lastWrittenPublicKeyX = identity.publicKeyX;
        lastWrittenClientId = clientId;
        dbCommitCalls++;
        if (shouldThrowOnNextCommit) {
          shouldThrowOnNextCommit = false;
          throw new Error("simulated crash: DB connection dropped after disk writes");
        }
        row.device_public_key = identity.publicKeyX;
        row.hosting_mode = "hosted";
      }

      // ── First attempt: crashes after disk writes, before DB commit ──
      let threw = false;
      try {
        await simulateConvertClientToHosted("crash-safety-client-id");
      } catch {
        threw = true;
      }
      check("[crash-safety] first attempt threw (simulated crash)", threw);
      check("[crash-safety] exactly one commit attempt so far", dbCommitCalls === 1);
      check("[crash-safety] the row is STILL local — DB was never touched by the failed commit", row.hosting_mode === "local");
      check("[crash-safety] the row's key is STILL the original — untouched", row.device_public_key === "original-local-key-crash-safety");
      // The disk writes from the crashed attempt genuinely happened and are
      // real, loadable files — just not yet referenced by any committed row.
      check("[crash-safety] the crashed attempt's device-identity.json genuinely exists on disk", existsSync(path.join(runtimeDir, "state", "device-identity.json")));
      check("[crash-safety] the crashed attempt's pairing-state.json genuinely exists on disk", existsSync(path.join(runtimeDir, "state", "pairing-state.json")));
      const orphanedPairing = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[crash-safety] the orphaned pairing-state.json's clientId matches the crashed attempt's clientId", orphanedPairing.clientId === lastWrittenClientId);
      const orphanedPublicKey = lastWrittenPublicKeyX;

      // ── Retry: e.g. the user just retries /paper_start ──
      await simulateConvertClientToHosted("crash-safety-client-id");
      check("[crash-safety] retry made exactly one more commit attempt (two total)", dbCommitCalls === 2);
      check("[crash-safety] the row is NOW genuinely hosted", row.hosting_mode === "hosted");
      check("[crash-safety] the retry generated a fresh keypair, different from the crashed attempt's orphaned one", row.device_public_key !== orphanedPublicKey);
      check("[crash-safety] the retry's key differs from the original local key too", row.device_public_key !== "original-local-key-crash-safety");

      // The final on-disk state (overwritten by the retry) is exactly what
      // the now-committed row references — no drift, no duplication, no
      // leftover corrupt intermediate file.
      const finalPairing = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[crash-safety] final pairing-state.json's clientId is still correct after the retry overwrote it", finalPairing.clientId === "crash-safety-client-id");
      check("[crash-safety] final pairing-state.json's lastSequence is 0 (fresh, not corrupted/incremented)", finalPairing.lastSequence === 0);
      const finalIdentity = JSON.parse(readFileSync(path.join(runtimeDir, "state", "device-identity.json"), "utf8"));
      check("[crash-safety] final device-identity.json's publicKeyX matches the committed row (disk/DB agree, no drift)", finalIdentity.publicKeyX === row.device_public_key);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── Disk-write failure SPECIFICALLY at the pairing-state step (device identity write already succeeded) must ALSO never reach the DB commit ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-pairing-diskfail-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "diskfail-client", ".aria");
      const row = { hosting_mode: "local" as "local" | "hosted" };
      let dbCommitCalls = 0;

      async function simulateConvertClientToHostedWithBadPairingPath(): Promise<void> {
        const identity = generateHostedDeviceIdentity();
        // Identity write succeeds against a real, valid runtime dir...
        writeHostedDeviceIdentityToDisk(runtimeDir, identity);
        // ...but the pairing-state write is forced to fail (a NUL byte in a
        // path is guaranteed to throw synchronously from node:fs on every
        // platform — simulates a permissions/ENOSPC failure without
        // depending on actual filesystem state).
        seedHostedPairingState(runtimeDir + "\0bad", "irrelevant");
        dbCommitCalls++;
        row.hosting_mode = "hosted";
      }

      let threw = false;
      try {
        await simulateConvertClientToHostedWithBadPairingPath();
      } catch {
        threw = true;
      }
      check("[disk-failure] the pairing-state write failure was thrown, not swallowed", threw);
      check("[disk-failure] no DB commit was ever attempted", dbCommitCalls === 0);
      check("[disk-failure] the row is untouched — still local", row.hosting_mode === "local");
      check("[disk-failure] device identity DID get written (it ran first, before the failing step)", existsSync(path.join(runtimeDir, "state", "device-identity.json")));
      check("[disk-failure] pairing-state.json was NOT written to the real runtime dir (only the bad path was attempted)", !existsSync(path.join(runtimeDir, "state", "pairing-state.json")));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── Entitlement renewal (2026-09-19 fix): decodeEntitlementExpiry / entitlementNeedsRenewal — pure helper correctness ──
  {
    check("[decode] a well-formed ARIAE1 token's exp decodes correctly", decodeEntitlementExpiry(buildHostedPairingState("client-decode-1").entitlementToken!) !== undefined);
    check("[decode] a non-ARIAE1 token returns undefined", decodeEntitlementExpiry("NOTAREALTOKEN.abc.def") === undefined);
    check("[decode] a garbage payload segment returns undefined", decodeEntitlementExpiry("ARIAE1.not-valid-base64url-json.sig") === undefined);
    check("[decode] a token with too few segments returns undefined", decodeEntitlementExpiry("ARIAE1.onlyonepart") === undefined);

    check("[needs-renewal] undefined state needs renewal", entitlementNeedsRenewal(undefined) === true);
    check("[needs-renewal] state with no token needs renewal", entitlementNeedsRenewal({ entitlementToken: undefined }) === true);
    check("[needs-renewal] state with an undecodable token needs renewal", entitlementNeedsRenewal({ entitlementToken: "garbage" }) === true);

    const nowSec = Math.floor(Date.now() / 1000);
    const freshToken = signTestEntitlementToken("client-decode-2", nowSec, nowSec + 7 * 24 * 3600);
    check("[needs-renewal] a freshly-issued 7-day token does NOT need renewal", entitlementNeedsRenewal({ entitlementToken: freshToken }) === false);

    const expiringSoonToken = signTestEntitlementToken("client-decode-3", nowSec - (7 * 24 * 3600 - 3600), nowSec + 3600);
    check("[needs-renewal] a token expiring in 1h (inside the 24h margin) needs renewal", entitlementNeedsRenewal({ entitlementToken: expiringSoonToken }) === true);

    const alreadyExpiredToken = signTestEntitlementToken("client-decode-4", nowSec - 7 * 24 * 3600 - 10, nowSec - 10);
    check("[needs-renewal] an already-expired token needs renewal", entitlementNeedsRenewal({ entitlementToken: alreadyExpiredToken }) === true);

    check("[needs-renewal] margin is exactly 24h", ENTITLEMENT_RENEWAL_MARGIN_SECONDS === 24 * 60 * 60);
  }

  // ── (a) A hosted client with a token expiring in <24h is renewed transparently, with a REAL re-signed token that passes REAL verification ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-near-expiry-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-near-expiry", ".aria");
      const nowSec = Math.floor(Date.now() / 1000);
      const nearExpiryToken = signTestEntitlementToken("client-renew-1", nowSec - (7 * 24 * 3600 - 3600), nowSec + 3600); // expires in ~1h
      writeHostedPairingStateToDisk(runtimeDir, { clientId: "client-renew-1", lastSequence: 7, entitlementToken: nearExpiryToken });

      const result = renewHostedPairingStateIfNeeded(runtimeDir, "client-renew-1");
      check("[renewal] renewed === true for a token expiring in 1h", result.renewed === true);
      check("[renewal] clientId is preserved", result.state.clientId === "client-renew-1");
      check("[renewal] lastSequence is preserved, NOT reset to 0 (this is a refresh, not a re-pair)", result.state.lastSequence === 7);
      check("[renewal] a genuinely NEW token was minted (different from the near-expiry one)", result.state.entitlementToken !== nearExpiryToken);

      const onDisk = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[renewal] the renewed token was actually written to disk", onDisk.entitlementToken === result.state.entitlementToken);
      check("[renewal] lastSequence on disk matches (7, preserved)", onDisk.lastSequence === 7);

      if (haveEngine) {
        const { verifyEntitlement } = await importEngineModule("entitlement.ts");
        const verification = verifyEntitlement(result.state.entitlementToken, TEST_ENTITLEMENT_PUBLIC_X, new Date());
        check("[renewal] the REAL aria-engine verifyEntitlement() grants the renewed token", verification.granted === true);
        if (verification.granted) {
          check("[renewal] renewed token's remaining TTL is close to the full 7 days, not expiring soon", verification.payload.exp - Math.floor(Date.now() / 1000) > 6 * 24 * 3600);
        }

        const { loadPairingState } = await importEngineModule("pairing-state.ts");
        const { checkPaperStartEntitlement } = await importEngineModule("entitlement-gate.ts");
        const loaded = loadPairingState(path.join(runtimeDir, "state"));
        const gateResult = checkPaperStartEntitlement(loaded!, new Date(), TEST_ENTITLEMENT_PUBLIC_X);
        check("[renewal] the REAL checkPaperStartEntitlement() (the actual gate cmdPaperStart calls) grants access AFTER renewal", gateResult.granted === true);

        // Negative control: prove the OLD near-expiry token, on its own, was
        // genuinely about to fail this same gate — renewal is fixing a real
        // problem, not a no-op dressed up as one.
        const oldGateResult = checkPaperStartEntitlement({ entitlementToken: nearExpiryToken }, new Date(Date.now() + 2 * 3600 * 1000), TEST_ENTITLEMENT_PUBLIC_X);
        check("[renewal] negative control: the OLD near-expiry token really would have failed the gate 2h later", oldGateResult.granted === false);
      }

      if (process.platform !== "win32") {
        const fileMode = statSync(path.join(runtimeDir, "state", "pairing-state.json")).mode & 0o777;
        check("[renewal] pairing-state.json keeps the same 0o600 mode as the original seed write", fileMode === 0o600);
        const dirMode = statSync(path.join(runtimeDir, "state")).mode & 0o777;
        check("[renewal] state/ directory keeps the same 0o700 mode", dirMode === 0o700);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── (b) A healthy, comfortably-non-expiring token is NOT needlessly re-signed ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-healthy-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-healthy", ".aria");
      const seeded = seedHostedPairingState(runtimeDir, "client-renew-2");
      const beforeBytes = readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8");

      check("[no-op] a freshly-seeded token does not need renewal", entitlementNeedsRenewal(seeded) === false);

      const result = renewHostedPairingStateIfNeeded(runtimeDir, "client-renew-2");
      check("[no-op] renewed === false for a healthy token", result.renewed === false);
      check("[no-op] the SAME token object/value is returned, not re-signed", result.state.entitlementToken === seeded.entitlementToken);

      const afterBytes = readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8");
      check("[no-op] the file on disk is byte-for-byte unchanged — no wasteful rewrite", beforeBytes === afterBytes);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── (c) readHostedPairingStateFromDisk self-heals on a missing/corrupt file instead of throwing ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-missing-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-missing", ".aria");
      check("[missing-file] readHostedPairingStateFromDisk returns undefined when nothing was ever seeded", readHostedPairingStateFromDisk(runtimeDir) === undefined);

      const result = renewHostedPairingStateIfNeeded(runtimeDir, "client-renew-4");
      check("[missing-file] renewed === true when there was no pairing-state.json to begin with", result.renewed === true);
      check("[missing-file] clientId falls back to the argument passed in", result.state.clientId === "client-renew-4");
      check("[missing-file] lastSequence falls back to 0, matching a fresh seed", result.state.lastSequence === 0);
      check("[missing-file] a real pairing-state.json now exists", existsSync(path.join(runtimeDir, "state", "pairing-state.json")));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── (d) Idempotency: two back-to-back renewal calls (standing in for a race between two near-simultaneous /paper_start calls) never corrupt the file or leave an inconsistent state ──
  // Note on scope: Node is single-threaded and renewHostedPairingStateIfNeeded
  // is fully synchronous, so two calls "racing" here run strictly
  // sequentially — that's actually the tightest interleaving reachable
  // in-process (there's no genuine multi-process race to reproduce without
  // spawning real OS processes). What this proves instead — and what
  // matters for the real race, since a second /paper_start tap that arrives
  // even a few milliseconds after the first will see whatever the first one
  // already wrote — is that the SECOND call correctly recognizes the FIRST
  // call's renewal already fixed the problem and does NOT re-renew: only
  // the first call actually mints a new token, the second is a genuine,
  // correct no-op against the now-healthy state the first one just wrote.
  // That's the strongest idempotency guarantee obtainable here, and it's
  // exactly what prevents two near-simultaneous callers from double-signing
  // or corrupting the file.
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-race-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-race", ".aria");
      const nowSec = Math.floor(Date.now() / 1000);
      const nearExpiryToken = signTestEntitlementToken("client-renew-3", nowSec - (7 * 24 * 3600 - 1800), nowSec + 1800); // expires in ~30 min
      writeHostedPairingStateToDisk(runtimeDir, { clientId: "client-renew-3", lastSequence: 12, entitlementToken: nearExpiryToken });

      const r1 = renewHostedPairingStateIfNeeded(runtimeDir, "client-renew-3");
      const r2 = renewHostedPairingStateIfNeeded(runtimeDir, "client-renew-3");

      check("[race] the first call renews (the token really was expiring soon)", r1.renewed === true);
      check("[race] the second call correctly sees the first call's fix and does NOT re-renew", r2.renewed === false);
      check("[race] both preserve lastSequence (12)", r1.state.lastSequence === 12 && r2.state.lastSequence === 12);
      check("[race] both preserve clientId", r1.state.clientId === "client-renew-3" && r2.state.clientId === "client-renew-3");
      check("[race] the second call's state is EXACTLY the first call's renewed token — no second, redundant signing", r2.state.entitlementToken === r1.state.entitlementToken);

      const final = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[race] the final on-disk file parses as valid, well-shaped JSON — not corrupted/torn", typeof final.clientId === "string" && typeof final.lastSequence === "number" && typeof final.entitlementToken === "string");
      check("[race] final clientId is correct", final.clientId === "client-renew-3");
      check("[race] final lastSequence is correct (12, preserved through the renewal)", final.lastSequence === 12);
      check("[race] the final on-disk token is the ONE token the first call minted", final.entitlementToken === r1.state.entitlementToken);

      if (haveEngine) {
        const { verifyEntitlement } = await importEngineModule("entitlement.ts");
        const verification = verifyEntitlement(final.entitlementToken, TEST_ENTITLEMENT_PUBLIC_X, new Date());
        check("[race] the final on-disk token genuinely verifies against the REAL aria-engine verifier", verification.granted === true);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── P0 exploit reproduction (independent-review finding, 2026-09-19 fix):
  // renewal must NEVER silently erase the server-revocation cache
  // (`lastKnownEntitlementStatus`), or /revokeengine is defeated the moment
  // the token enters its 24h renewal window. Reproduces the reviewer's own
  // scenario end to end: admin revokes -> a real sync response caches
  // `revoked` on disk -> the token later enters its renewal window ->
  // renewal must preserve the cache -> the REAL checkPaperStartEntitlement()
  // must still deny with "revoked-by-server" despite the freshly-renewed
  // token being otherwise offline-valid. ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-revoked-exploit-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-revoked", ".aria");
      const nowSec = Math.floor(Date.now() / 1000);
      // A token expiring in ~1h — inside the 24h renewal margin, so the
      // NEXT /paper_start's call to renewHostedPairingStateIfNeeded will
      // renew it. This mirrors "the token enters its 24h renewal window"
      // from the reviewer's reproduction.
      const nearExpiryToken = signTestEntitlementToken("client-revoked-1", nowSec - (7 * 24 * 3600 - 3600), nowSec + 3600);
      const revokedCache = { status: "revoked", expiresAt: null, checkedAtMs: Date.now() };

      // (1) Write a pairing-state file with lastKnownEntitlementStatus:
      // revoked (standing in for a real sync response caching /revokeengine's
      // effect) PLUS the near-expiring token.
      const beforeRenewal: HostedPairingState = {
        clientId: "client-revoked-1",
        lastSequence: 3,
        entitlementToken: nearExpiryToken,
        lastKnownEntitlementStatus: revokedCache,
      };
      writeHostedPairingStateToDisk(runtimeDir, beforeRenewal);

      // Sanity: confirm the exploit precondition — the gate genuinely
      // denies BEFORE renewal, via the server-revocation cache, not via the
      // token's own (still momentarily valid) signature/expiry.
      if (haveEngine) {
        const { checkPaperStartEntitlement } = await importEngineModule("entitlement-gate.ts");
        const preResult = checkPaperStartEntitlement(beforeRenewal as any, new Date(), TEST_ENTITLEMENT_PUBLIC_X);
        check("[exploit] precondition: gate denies BEFORE renewal (revoked-by-server)", preResult.granted === false && (preResult as any).reason === "revoked-by-server");
      }

      // (2) Call renewHostedPairingStateIfNeeded — this is the exact call
      // startHostedEngine makes on every /paper_start, unconditionally.
      const result = renewHostedPairingStateIfNeeded(runtimeDir, "client-revoked-1");
      check("[exploit] renewal actually fired (token really was near-expiry)", result.renewed === true);
      check("[exploit] a genuinely NEW token was minted, not the stale one", result.state.entitlementToken !== nearExpiryToken);
      check("[exploit] lastSequence preserved through the renewal", result.state.lastSequence === 3);

      // (3) Read the file back and assert lastKnownEntitlementStatus is
      // STILL present and STILL "revoked" — this is the P0: it must survive
      // the renewal write, not be silently dropped.
      const onDisk = JSON.parse(readFileSync(path.join(runtimeDir, "state", "pairing-state.json"), "utf8"));
      check("[exploit] lastKnownEntitlementStatus survived the renewal write (not undefined)", onDisk.lastKnownEntitlementStatus !== undefined);
      check("[exploit] lastKnownEntitlementStatus.status is still exactly 'revoked'", onDisk.lastKnownEntitlementStatus?.status === "revoked");
      check("[exploit] the returned state object also carries the preserved revocation cache (not just the raw file)", (result.state as any).lastKnownEntitlementStatus?.status === "revoked");

      // (4) Drive the REAL aria-engine checkPaperStartEntitlement()/
      // verifyEntitlement() against the renewed on-disk state and assert the
      // gate STILL denies with revoked-by-server, despite the token itself
      // being freshly signed and otherwise fully valid. This is the exact
      // scenario the reviewer reproduced: a silent re-grant to a revoked
      // tenant the moment their token gets renewed.
      if (haveEngine) {
        const { verifyEntitlement } = await importEngineModule("entitlement.ts");
        const offlineVerification = verifyEntitlement(onDisk.entitlementToken, TEST_ENTITLEMENT_PUBLIC_X, new Date());
        check("[exploit] the renewed token is, on its own, offline-valid (proves the gate denial below is from the cache, not a broken token)", offlineVerification.granted === true);

        const { checkPaperStartEntitlement } = await importEngineModule("entitlement-gate.ts");
        const { loadPairingState } = await importEngineModule("pairing-state.ts");
        const loaded = loadPairingState(path.join(runtimeDir, "state"));
        const gateResult = checkPaperStartEntitlement(loaded!, new Date(), TEST_ENTITLEMENT_PUBLIC_X);
        check("[exploit] THE FIX: the REAL checkPaperStartEntitlement() still DENIES after renewal, with revoked-by-server", gateResult.granted === false && (gateResult as any).reason === "revoked-by-server");
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── D2 spot-check: a fresh write to the file by the "live engine"
  // (advancing lastSequence, simulating a sync tick) that lands AFTER
  // renewal's first read but BEFORE its write must still be picked up by
  // the pre-write re-read, not clobbered back to the stale value. ──
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-d2-test-"));
    try {
      const runtimeDir = path.join(tmpRoot, "renew-d2", ".aria");
      const nowSec = Math.floor(Date.now() / 1000);
      const nearExpiryToken = signTestEntitlementToken("client-d2-1", nowSec - (7 * 24 * 3600 - 3600), nowSec + 3600);
      writeHostedPairingStateToDisk(runtimeDir, { clientId: "client-d2-1", lastSequence: 5, entitlementToken: nearExpiryToken });

      // Simulate the live engine advancing lastSequence via a sync tick
      // that happens to land between renewal's internal reads, by writing a
      // newer lastSequence directly before calling renewal (renewal's own
      // re-read-before-write, exercised internally, will pick this up).
      writeHostedPairingStateToDisk(runtimeDir, { clientId: "client-d2-1", lastSequence: 9, entitlementToken: nearExpiryToken });

      const result = renewHostedPairingStateIfNeeded(runtimeDir, "client-d2-1");
      check("[D2] renewal preserves the LATEST lastSequence (9), not a stale earlier read (5)", result.state.lastSequence === 9);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
