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
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync } from "node:crypto";

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

const { seedHostedPairingState, buildHostedPairingState, writeHostedPairingStateToDisk } = await import("./hosted-pairing-seed.js");
const { generateHostedDeviceIdentity, writeHostedDeviceIdentityToDisk } = await import("./hosted-device-identity.js");

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

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
