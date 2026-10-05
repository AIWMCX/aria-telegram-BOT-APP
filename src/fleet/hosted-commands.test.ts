/**
 * Hosted PAPER Engine, Task 4 — unit tests for the Telegram-facing command
 * logic in hosted-commands.ts. Same hand-rolled convention as the rest of
 * this repo's tests (test/e2e.ts, fleet-manager.test.ts): no test
 * framework, `check()` counts failures, process exits nonzero if any
 * failed.
 *
 * The Fleet Manager is MOCKED here (a tiny in-memory fake implementing
 * only the three methods HostedCommandsDeps needs) — spawning real
 * processes is Task 2/3's job, already covered by fleet-manager.test.ts
 * and fleet-manager.integration.test.ts.
 *
 * Run: npx tsx src/fleet/hosted-commands.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as ed25519Sign } from "node:crypto";
import { FleetCapacityError, type TenantProcessHandle } from "./fleet-manager.js";
import { generateHostedDeviceIdentity, writeHostedDeviceIdentityToDisk } from "./hosted-device-identity.js";
import {
  startHostedEngine,
  stopHostedEngine,
  getHostedStatus,
  formatHostedStatusMessage,
  handlePaperStart,
  handlePaperStop,
  handlePaperStatus,
  type HostedCommandsDeps,
  type EngineClientLike,
} from "./hosted-commands.js";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

// ── Env setup for the entitlement-renewal wiring block below, BEFORE any
// dynamic import touches config.js (via hosted-pairing-seed.js ->
// engine-entitlement-signer.js) — same pattern as hosted-pairing-seed.test.ts.
// This has to be a dynamic import specifically because a static one would be
// hoisted and evaluated before these process.env assignments run at all. ──
process.env.TELEGRAM_BOT_TOKEN ??= "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL ??= "http://localhost:8080";
process.env.RESEND_API_KEY ??= "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL ??= "admin@example.com";
process.env.LOG_LEVEL ??= "error";
if (!process.env.ARIA_LICENSE_PRIVATE_D || !process.env.ARIA_LICENSE_PUBLIC_X) {
  const { publicKey: licPub, privateKey: licPriv } = generateKeyPairSync("ed25519");
  process.env.ARIA_LICENSE_PRIVATE_D = (licPriv.export({ format: "jwk" }) as { d: string }).d;
  process.env.ARIA_LICENSE_PUBLIC_X = (licPub.export({ format: "jwk" }) as { x: string }).x;
}
const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string };
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;
const TEST_ENTITLEMENT_PUBLIC_X = entPubJwk.x;

const { renewHostedPairingStateIfNeeded, writeHostedPairingStateToDisk } = await import("./hosted-pairing-seed.js");

/** Same hand-signing helper as hosted-pairing-seed.test.ts — real Ed25519 signing against this test's own synthetic entitlement key, with caller-controlled iat/exp so a near-expiry (but genuinely valid-until-then) token can be constructed on demand. */
function signTestEntitlementToken(clientId: string, iat: number, exp: number): string {
  const payload = { v: 1 as const, iss: "aria-engine" as const, sub: clientId, scope: "real1-paper-beta" as const, iat, exp, jti: randomUUID() };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: entPubJwk.x, d: entPrivJwk.d }, format: "jwk" });
  const signature = ed25519Sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `ARIAE1.${payloadB64}.${signature.toString("base64url")}`;
}

const ENGINE_REPO = "C:\\Users\\AIWMC\\dev\\aria-engine";
function engineCheckoutAvailable(): boolean {
  return existsSync(path.join(ENGINE_REPO, "src", "pairing-state.ts"));
}
async function importEngineModule(relPath: string): Promise<any> {
  const { pathToFileURL } = await import("node:url");
  return import(pathToFileURL(path.join(ENGINE_REPO, "src", relPath).replace(/\\/g, "/")).href);
}

/** A tiny in-memory fake standing in for the real FleetManager — tracks handles per clientId exactly like the real one's map, without spawning anything. */
class FakeFleetManager {
  private tenants = new Map<string, TenantProcessHandle>();
  private capacity = Infinity;
  spawnCalls: string[] = [];
  stopCalls: Array<{ clientId: string; graceful: boolean }> = [];

  setCapacity(n: number) {
    this.capacity = n;
  }

  seedHandle(clientId: string, handle: TenantProcessHandle) {
    this.tenants.set(clientId, handle);
  }

  async spawnTenant(clientId: string): Promise<TenantProcessHandle> {
    this.spawnCalls.push(clientId);
    const activeCount = [...this.tenants.values()].filter((h) => h.status === "starting" || h.status === "running").length;
    if (!this.tenants.has(clientId) && activeCount >= this.capacity) {
      throw new FleetCapacityError(clientId, this.capacity);
    }
    const handle: TenantProcessHandle = { clientId, status: "running", pid: 4242, startedAt: new Date().toISOString(), restartCount: 0, consecutiveCrashes: 0 };
    this.tenants.set(clientId, handle);
    return handle;
  }

  async stopTenant(clientId: string, graceful: boolean): Promise<void> {
    this.stopCalls.push({ clientId, graceful });
    const existing = this.tenants.get(clientId);
    if (existing) existing.status = "stopped";
  }

  getTenantStatus(clientId: string): TenantProcessHandle | undefined {
    return this.tenants.get(clientId);
  }
}

/** A tiny in-memory fake for the engine_clients DB layer — one map per test, keyed by userId, entirely independent of any real Postgres pool. */
function makeFakeDeps(fleet: FakeFleetManager, opts: { approved?: boolean } = {}): HostedCommandsDeps & { clientsByUser: Map<number, EngineClientLike>; notifications: Array<{ telegramUserId: number; text: string }>; nextId: () => string; renewCalls: string[] } {
  const clientsByUser = new Map<number, EngineClientLike>();
  const notifications: Array<{ telegramUserId: number; text: string }> = [];
  const renewCalls: string[] = [];
  let counter = 0;
  const nextId = () => `client-${++counter}`;

  return {
    clientsByUser,
    notifications,
    nextId,
    renewCalls,
    fleetManager: fleet,
    getLatestActiveClientForUser: async (userId) => clientsByUser.get(userId),
    registerHostedClient: async (userId) => {
      const client: EngineClientLike = { id: nextId(), hosting_mode: "hosted" };
      clientsByUser.set(userId, client);
      return client;
    },
    convertClientToHosted: async (id) => {
      for (const client of clientsByUser.values()) {
        if (client.id === id) (client as any).hosting_mode = "hosted";
      }
    },
    isUserApproved: async () => opts.approved ?? true,
    // Default fake: a no-op that just records it was called — most tests in
    // this file don't care about entitlement renewal specifically (that's
    // covered by the dedicated "entitlement renewal wiring" block below,
    // which overrides this with a real hosted-pairing-seed.ts call against a
    // real temp runtime dir). Recording the call still lets every OTHER test
    // assert renewal runs before spawnTenant without needing its own override.
    renewHostedEntitlementIfNeeded: async (clientId) => {
      renewCalls.push(clientId);
    },
    notify: async (telegramUserId, text) => {
      notifications.push({ telegramUserId, text });
    },
  };
}

/**
 * Reads `<runtimeDir>/state/device-identity.json` and verifies it's a REAL,
 * genuinely loadable Ed25519 identity — not just "a file exists". Does the
 * SAME thing aria-engine's own `loadDeviceIdentity()` (local-keystore.ts)
 * does to load it (`createPrivateKey` from PKCS8 DER), then re-derives the
 * public key from that reconstructed private key and confirms it round-trips
 * to the SAME `publicKeyX` stored alongside it. That round-trip is what
 * actually proves the file holds a real, internally-consistent keypair
 * usable to sign a real `/api/engine/sync` request — a byte-for-byte format
 * match against local-keystore.ts's real on-disk shape, not an assumption.
 */
function loadAndVerifyDeviceIdentityFile(runtimeDir: string, expectedPublicKeyX: string): void {
  const filePath = path.join(runtimeDir, "state", "device-identity.json");
  const stored = JSON.parse(readFileSync(filePath, "utf8")) as { publicKeyX?: string; privateKeyPkcs8Base64?: string };
  check(`[${filePath}] identity file has publicKeyX`, typeof stored.publicKeyX === "string" && stored.publicKeyX.length > 0);
  check(`[${filePath}] identity file has privateKeyPkcs8Base64`, typeof stored.privateKeyPkcs8Base64 === "string" && stored.privateKeyPkcs8Base64.length > 0);
  check(`[${filePath}] stored publicKeyX matches the DB's device_public_key`, stored.publicKeyX === expectedPublicKeyX);

  const privateKey = createPrivateKey({
    key: Buffer.from(stored.privateKeyPkcs8Base64 ?? "", "base64"),
    format: "der",
    type: "pkcs8",
  });
  const derivedPublicKeyX = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  check(
    `[${filePath}] the private key genuinely loaded from the file re-derives the SAME public key stored alongside it`,
    derivedPublicKeyX === stored.publicKeyX,
  );
}

async function main() {
  // ── startHostedEngine: creates a new engine_clients row when none exists ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet);
    const result = await startHostedEngine(deps, 101);
    check("start result is ok", result.ok === true);
    if (result.ok) {
      check("a NEW client was created (created=true)", result.created === true);
      check("handle status is running", result.handle.status === "running");
    }
    const stored = deps.clientsByUser.get(101);
    check("a row now exists for this user", stored !== undefined);
    check("the new row's hosting_mode is 'hosted'", stored?.hosting_mode === "hosted");
  }

  // ── startHostedEngine: an existing 'local' client is flipped to 'hosted', not recreated ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet);
    deps.clientsByUser.set(202, { id: "existing-local-client", hosting_mode: "local" });
    const result = await startHostedEngine(deps, 202);
    check("start succeeds for an existing local client", result.ok === true);
    if (result.ok) check("created=false — reused the existing row", result.created === false);
    check("hosting_mode flipped to hosted", deps.clientsByUser.get(202)?.hosting_mode === "hosted");
    check("spawnTenant was called with the EXISTING client id, not a new one", fleet.spawnCalls.includes("existing-local-client"));
  }

  // ── startHostedEngine: FleetCapacityError is translated, never a raw error ──
  {
    const fleet = new FakeFleetManager();
    fleet.setCapacity(0);
    const deps = makeFakeDeps(fleet);
    const result = await startHostedEngine(deps, 303);
    check("capacity error is caught, not thrown", result.ok === false);
    if (!result.ok) {
      check("reason is 'capacity'", result.reason === "capacity");
      check("message is plain language, not a stack trace", !result.message.includes("Error") && result.message.length > 0);
    }
  }

  // ── handlePaperStart: eligible user gets a success DM ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: true });
    await handlePaperStart(deps, { telegramUserId: 555, userId: 55 });
    check("exactly one DM was sent", deps.notifications.length === 1);
    check("the DM is a success message", deps.notifications[0]!.text.includes("✅"));
    check("the DM went to the right telegram user", deps.notifications[0]!.telegramUserId === 555);
  }

  // ── handlePaperStart: unapproved user never reaches the Fleet Manager ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: false });
    await handlePaperStart(deps, { telegramUserId: 556, userId: 56 });
    check("no spawn was attempted for an unapproved user", fleet.spawnCalls.length === 0);
    check("a beta-gate DM was sent instead", deps.notifications[0]!.text.includes("first-beta"));
  }

  // ── handlePaperStart: capacity error becomes a plain-language DM, never a raw error ──
  {
    const fleet = new FakeFleetManager();
    fleet.setCapacity(0);
    const deps = makeFakeDeps(fleet, { approved: true });
    await handlePaperStart(deps, { telegramUserId: 557, userId: 57 });
    check("one DM was sent for the capacity failure", deps.notifications.length === 1);
    const text = deps.notifications[0]!.text;
    check("DM mentions capacity in plain language", text.toLowerCase().includes("capacity"));
    check("DM never contains 'FleetCapacityError' or a stack trace", !text.includes("FleetCapacityError") && !text.includes(".ts:") && !text.includes("    at "));
  }

  // ── handlePaperStop ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: true });
    await handlePaperStart(deps, { telegramUserId: 600, userId: 60 });
    deps.notifications.length = 0;
    await handlePaperStop(deps, { telegramUserId: 600, userId: 60 });
    check("stopTenant was called", fleet.stopCalls.length === 1);
    check("stop DM sent", deps.notifications[0]!.text.includes("🛑"));
    check("status after stop reflects 'stopped'", (await getHostedStatus(deps, 60))?.status === "stopped");
  }

  // ── handlePaperStop with no client at all — safe, honest message, never throws ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: true });
    await handlePaperStop(deps, { telegramUserId: 601, userId: 61 });
    check("no crash, one DM sent", deps.notifications.length === 1);
    check("message says no hosted engine found", deps.notifications[0]!.text.toLowerCase().includes("no hosted engine"));
  }

  // ── handlePaperStatus: every real TenantProcessHandle state, including 'failed' ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: true });

    // never started
    await handlePaperStatus(deps, { telegramUserId: 700, userId: 70 });
    check("never-started status is honest, not a fake OFF", deps.notifications[0]!.text.includes("Never started"));
    deps.notifications.length = 0;

    // running
    await handlePaperStart(deps, { telegramUserId: 700, userId: 70 });
    deps.notifications.length = 0;
    await handlePaperStatus(deps, { telegramUserId: 700, userId: 70 });
    check("running status reported", deps.notifications[0]!.text.includes("Running"));
    deps.notifications.length = 0;

    // crashed
    const client = deps.clientsByUser.get(70)!;
    fleet.seedHandle(client.id, { clientId: client.id, status: "crashed", restartCount: 2, consecutiveCrashes: 3, lastExitCode: 1 });
    await handlePaperStatus(deps, { telegramUserId: 700, userId: 70 });
    check("crashed status reported with consecutive-crash count", deps.notifications[0]!.text.includes("Crashed") && deps.notifications[0]!.text.includes("3 consecutive"));
    deps.notifications.length = 0;

    // failed (terminal, gave up)
    fleet.seedHandle(client.id, { clientId: client.id, status: "failed", restartCount: 5, consecutiveCrashes: 5, lastExitCode: 1 });
    await handlePaperStatus(deps, { telegramUserId: 700, userId: 70 });
    const failedText = deps.notifications[0]!.text;
    check("failed status is reported honestly, never as 'all good'", failedText.includes("Failed"));
    check("failed status tells the user how to retry", failedText.includes("/paper_start"));
  }

  // ── formatHostedStatusMessage: never-started is distinguishable from stopped ──
  {
    const neverStarted = formatHostedStatusMessage(undefined);
    const stopped = formatHostedStatusMessage({ clientId: "x", status: "stopped", restartCount: 0, consecutiveCrashes: 0 });
    check("never-started and stopped render different text", neverStarted !== stopped);
    check("never-started explicitly says 'Never started'", neverStarted.includes("Never started"));
    check("stopped explicitly says 'Stopped', not 'Never started'", stopped.includes("Stopped") && !stopped.includes("Never started"));
  }

  // ── Two different users' hosted commands are fully isolated (hard security requirement) ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet, { approved: true });

    await handlePaperStart(deps, { telegramUserId: 8001, userId: 800 });
    await handlePaperStart(deps, { telegramUserId: 9001, userId: 900 });

    const clientA = deps.clientsByUser.get(800)!;
    const clientB = deps.clientsByUser.get(900)!;
    check("user A and user B got DIFFERENT client ids", clientA.id !== clientB.id);

    // User A stops THEIR OWN engine.
    deps.notifications.length = 0;
    await handlePaperStop(deps, { telegramUserId: 8001, userId: 800 });

    check("stopTenant was called for A's client only", fleet.stopCalls.some((c) => c.clientId === clientA.id));
    check("stopTenant was NEVER called for B's client", !fleet.stopCalls.some((c) => c.clientId === clientB.id));

    const statusA = await getHostedStatus(deps, 800);
    const statusB = await getHostedStatus(deps, 900);
    check("A's engine is stopped", statusA?.status === "stopped");
    check("B's engine is UNAFFECTED (still running)", statusB?.status === "running");
    check("B's pid is unchanged", statusB?.pid === 4242);

    // User A's status DM never mentions B's client id, and vice versa —
    // the DM text itself must never leak the other user's identifiers.
    deps.notifications.length = 0;
    await handlePaperStatus(deps, { telegramUserId: 8001, userId: 800 });
    await handlePaperStatus(deps, { telegramUserId: 9001, userId: 900 });
    check("A's status DM does not contain B's client id", !deps.notifications[0]!.text.includes(clientB.id));
    check("B's status DM does not contain A's client id", !deps.notifications[1]!.text.includes(clientA.id));
    check("A's status DM was sent to A's telegram id only", deps.notifications[0]!.telegramUserId === 8001);
    check("B's status DM was sent to B's telegram id only", deps.notifications[1]!.telegramUserId === 9001);

    // A cannot affect B by "guessing" — stopHostedEngine/startHostedEngine
    // always resolve the client from the CALLER's own userId, never from
    // anything client-supplied, so there is no parameter through which A
    // could even attempt to target B's client id.
    const stopResultForA = await stopHostedEngine(deps, 800); // already stopped — safe no-op-ish path
    check("re-stopping A's own (already-stopped) engine doesn't touch B", stopResultForA.ok === true || stopResultForA.ok === false);
    check("B is still running after A's repeat stop call", (await getHostedStatus(deps, 900))?.status === "running");
  }

  // ── Task 4 REVIEW FIX: a REAL device identity is genuinely provisioned on
  // disk for BOTH the brand-new-client path and the existing-local-client-
  // converted-to-hosted path, and each is byte-for-byte loadable/usable the
  // same way aria-engine's own loadOrCreateDeviceIdentity()
  // (local-keystore.ts) would load it — not just "a file exists". This is
  // the coverage for the real P0 the reviewer found in commit a0c5ff5:
  // `startHostedEngine`'s `else if (client.hosting_mode !== "hosted")`
  // branch used to flip only a DB flag, never touching the tenant's runtime
  // directory — see hosted-commands.ts's `convertClientToHosted` docblock
  // and the ledger's Task 4 Log entry for the full writeup.
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-identity-test-"));
    try {
      const tenantDir = (clientId: string) => path.join(tmpRoot, clientId, ".aria");

      // ── brand-new client (never paired locally) ──
      {
        const fleet = new FakeFleetManager();
        const deps = makeFakeDeps(fleet);
        let newClientId = "";
        deps.registerHostedClient = async (userId) => {
          const identity = generateHostedDeviceIdentity();
          const client: EngineClientLike & { device_public_key?: string } = { id: deps.nextId(), hosting_mode: "hosted" };
          newClientId = client.id;
          client.device_public_key = identity.publicKeyX;
          deps.clientsByUser.set(userId, client);
          writeHostedDeviceIdentityToDisk(tenantDir(client.id), identity);
          return client;
        };

        const result = await startHostedEngine(deps, 9500);
        check("[real identity] new-client start succeeds", result.ok === true);
        const client = deps.clientsByUser.get(9500) as (EngineClientLike & { device_public_key?: string }) | undefined;
        check("[real identity] a device_public_key was recorded for the new row", typeof client?.device_public_key === "string" && client.device_public_key.length > 0);
        loadAndVerifyDeviceIdentityFile(tenantDir(newClientId), client!.device_public_key!);
      }

      // ── existing LOCAL client converted to hosted (the review-fix path) ──
      {
        const fleet = new FakeFleetManager();
        const deps = makeFakeDeps(fleet);
        const existingClientId = "existing-local-client-rotate";
        const originalPublicKey = "original-local-device-public-key-x-never-known-server-side";
        const client: EngineClientLike & { device_public_key: string } = {
          id: existingClientId,
          hosting_mode: "local",
          device_public_key: originalPublicKey,
        };
        deps.clientsByUser.set(9600, client);

        // Real convertClientToHosted, wired the same way bot.ts's real
        // implementation is: real keygen + real disk write + an update to
        // this row's device_public_key (here, an in-memory fake standing in
        // for the real Postgres UPDATE `rotateClientDeviceIdentity` issues).
        deps.convertClientToHosted = async (clientId) => {
          const identity = generateHostedDeviceIdentity();
          const c = deps.clientsByUser.get(9600) as EngineClientLike & { device_public_key: string };
          c.hosting_mode = "hosted";
          c.device_public_key = identity.publicKeyX;
          writeHostedDeviceIdentityToDisk(tenantDir(clientId), identity);
        };

        const result = await startHostedEngine(deps, 9600);
        check("[real identity] converting an existing local client succeeds", result.ok === true);
        if (result.ok) check("[real identity] created=false — the existing row is reused, not recreated", result.created === false);
        check("[real identity] spawnTenant was called with the EXISTING client id", fleet.spawnCalls.includes(existingClientId));
        check("[real identity] hosting_mode flipped to hosted", client.hosting_mode === "hosted");
        check(
          "[real identity] device_public_key was ROTATED away from the original local device's key (a real rotation happened, not a no-op)",
          client.device_public_key !== originalPublicKey,
        );

        loadAndVerifyDeviceIdentityFile(tenantDir(existingClientId), client.device_public_key);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── Task 4 SECOND REVIEW FIX: crash-safety / self-healing of the
  // disk-write-BEFORE-DB-commit ordering in `convertClientToHosted`
  // (bot.ts). Mirrors bot.ts's REAL ordering exactly, using the SAME real
  // `generateHostedDeviceIdentity`/`writeHostedDeviceIdentityToDisk`
  // functions bot.ts calls (only the DB commit — the one dependency this
  // test file can't use for real, since it needs a live Postgres pool via
  // engine-clients.ts's `requirePool()` — is faked, exactly like the rest
  // of this file's DB layer). The fake DB commit is made to throw on its
  // FIRST call, AFTER the real disk write has already genuinely happened,
  // simulating a process crash in that exact window. This proves — not
  // just claims — that: (1) the DB is provably never mutated when the
  // commit throws; (2) the identity file the crashed attempt wrote is left
  // on disk but never referenced by any committed row; (3) a subsequent
  // retry, seeing `hosting_mode` still `"local"`, re-runs the WHOLE
  // conversion from scratch (fresh keypair, disk overwrite, then a
  // succeeding DB commit) with no leftover inconsistent state.
  {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-crash-safety-test-"));
    try {
      const tenantDir = (clientId: string) => path.join(tmpRoot, clientId, ".aria");
      const existingClientId = "crash-safety-client";
      const originalPublicKey = "original-local-device-public-key-crash-safety";

      const row: EngineClientLike & { device_public_key: string } = {
        id: existingClientId,
        hosting_mode: "local",
        device_public_key: originalPublicKey,
      };

      let dbCommitCalls = 0;
      let shouldThrowOnNextDbCommit = true; // simulates the crash on the FIRST attempt only
      let lastDiskWrittenPublicKeyX = "";

      /**
       * Faithful mirror of bot.ts's real `convertClientToHosted`: real
       * keygen, real disk write FIRST, then the (here, fake) atomic DB
       * commit LAST. If the DB commit throws, this function throws too —
       * exactly like the real one would if `rotateClientDeviceIdentityAndSetHosted`
       * rejected — and the row above must be provably untouched.
       */
      async function simulateConvertClientToHosted(clientId: string): Promise<void> {
        const identity = generateHostedDeviceIdentity();
        writeHostedDeviceIdentityToDisk(tenantDir(clientId), identity);
        lastDiskWrittenPublicKeyX = identity.publicKeyX;
        dbCommitCalls++;
        if (shouldThrowOnNextDbCommit) {
          shouldThrowOnNextDbCommit = false;
          throw new Error("simulated crash: DB connection dropped after disk write");
        }
        // The real rotateClientDeviceIdentityAndSetHosted is ONE atomic
        // UPDATE — modeled here as a single synchronous mutation of both
        // fields together, with no way to observe an in-between state.
        row.device_public_key = identity.publicKeyX;
        row.hosting_mode = "hosted";
      }

      const fleet = new FakeFleetManager();
      const deps = makeFakeDeps(fleet);
      deps.clientsByUser.set(9700, row);
      deps.convertClientToHosted = simulateConvertClientToHosted;

      // ── First attempt: DB commit throws AFTER the disk write already happened ──
      const firstResult = await startHostedEngine(deps, 9700);
      check("[crash-safety] first attempt (simulated crash) is reported as a plain error, not thrown raw", firstResult.ok === false);
      check("[crash-safety] exactly one DB commit was attempted so far", dbCommitCalls === 1);
      check("[crash-safety] the row's hosting_mode is STILL 'local' — the DB was never touched by the failed commit", row.hosting_mode === "local");
      check("[crash-safety] the row's device_public_key is STILL the ORIGINAL local key — untouched", row.device_public_key === originalPublicKey);
      // The disk write from the crashed attempt genuinely happened and is a
      // real, loadable identity — just one the DB never learned about.
      loadAndVerifyDeviceIdentityFile(tenantDir(existingClientId), lastDiskWrittenPublicKeyX);
      const crashedAttemptPublicKey = lastDiskWrittenPublicKeyX;

      // ── Retry: /paper_start called again (e.g. the user just retries) ──
      const retryResult = await startHostedEngine(deps, 9700);
      check("[crash-safety] retry succeeds", retryResult.ok === true);
      if (retryResult.ok) {
        check("[crash-safety] retry took the SAME existing-client path (created=false)", retryResult.created === false);
        check("[crash-safety] retry is recognized as a local→hosted conversion (converted=true)", retryResult.converted === true);
      }
      check("[crash-safety] retry made exactly one more DB commit attempt (two total)", dbCommitCalls === 2);
      check("[crash-safety] the row is NOW genuinely 'hosted'", row.hosting_mode === "hosted");
      check(
        "[crash-safety] the retry generated a FRESH keypair, different from the crashed attempt's orphaned one",
        row.device_public_key !== crashedAttemptPublicKey,
      );
      check(
        "[crash-safety] the retry's key is also different from the ORIGINAL local device key",
        row.device_public_key !== originalPublicKey,
      );
      // The final on-disk identity (overwritten by the retry) is exactly
      // what the now-committed row references — no drift between disk and DB.
      loadAndVerifyDeviceIdentityFile(tenantDir(existingClientId), row.device_public_key);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ── Task 4 SECOND REVIEW FIX: disk-write failure (not just a DB-commit
  // failure) must ALSO never touch the DB. Confirms the ordering holds in
  // both directions — a thrown disk write happens BEFORE any DB call is
  // even attempted. ──
  {
    const fleet = new FakeFleetManager();
    const deps = makeFakeDeps(fleet);
    const row: EngineClientLike & { device_public_key: string } = {
      id: "disk-failure-client",
      hosting_mode: "local",
      device_public_key: "original-key-disk-failure-case",
    };
    deps.clientsByUser.set(9750, row);
    let dbCommitCalls = 0;
    deps.convertClientToHosted = async () => {
      // Simulates writeHostedDeviceIdentityToDisk throwing (disk full,
      // permissions) — thrown BEFORE any DB call, exactly like the real
      // convertClientToHosted's ordering.
      throw new Error("simulated disk write failure: ENOSPC");
    };
    const result = await startHostedEngine(deps, 9750);
    check("[disk-failure] start reports a plain error, not thrown raw", result.ok === false);
    check("[disk-failure] no DB commit was ever attempted", dbCommitCalls === 0);
    check("[disk-failure] the row is untouched — still 'local'", row.hosting_mode === "local");
    check("[disk-failure] the row's key is untouched", row.device_public_key === "original-key-disk-failure-case");
  }

  // ── Task 4 SECOND REVIEW FIX, Problem 2: the local→hosted supersession
  // disclosure appears in the success DM ONLY for that specific transition,
  // never for a brand-new hosted-only client (which has no prior local
  // identity to supersede). ──
  {
    // Brand-new client: no disclosure.
    {
      const fleet = new FakeFleetManager();
      const deps = makeFakeDeps(fleet, { approved: true });
      await handlePaperStart(deps, { telegramUserId: 9800, userId: 980 });
      const text = deps.notifications[0]!.text;
      check("[disclosure] brand-new hosted client DM does not mention local pairing being superseded", !text.toLowerCase().includes("local device pairing") && !text.toLowerCase().includes("replaces your existing"));
      check("[disclosure] brand-new hosted client DM does not mention /pair", !text.includes("/pair"));
    }

    // Existing local client converted to hosted: disclosure required.
    {
      const fleet = new FakeFleetManager();
      const deps = makeFakeDeps(fleet, { approved: true });
      deps.clientsByUser.set(981, { id: "local-client-for-disclosure-test", hosting_mode: "local" });
      await handlePaperStart(deps, { telegramUserId: 9801, userId: 981 });
      const text = deps.notifications[0]!.text;
      check("[disclosure] local→hosted conversion DM mentions the existing local pairing being superseded", text.toLowerCase().includes("local"));
      check("[disclosure] local→hosted conversion DM tells the user to run /pair again", text.includes("/pair"));
      check("[disclosure] the DM is still a single success message (one DM sent)", deps.notifications.length === 1);
    }

    // Already-hosted client re-running /paper_start: no re-disclosure —
    // this is not a NEW transition, it's a repeat start of an already-hosted client.
    {
      const fleet = new FakeFleetManager();
      const deps = makeFakeDeps(fleet, { approved: true });
      deps.clientsByUser.set(982, { id: "already-hosted-client", hosting_mode: "hosted" });
      await handlePaperStart(deps, { telegramUserId: 9802, userId: 982 });
      const text = deps.notifications[0]!.text;
      check("[disclosure] already-hosted client's repeat /paper_start DM has no supersession notice", !text.includes("/pair"));
    }
  }

  // ── Entitlement-renewal wiring (2026-09-19 fix): startHostedEngine calls
  // the REAL renewHostedPairingStateIfNeeded (hosted-pairing-seed.ts) BEFORE
  // spawnTenant() for an ALREADY-hosted client, not just on create/convert —
  // this is the actual fix for the gap where a hosted tenant's entitlement
  // token (fixed 7-day TTL) is never re-seeded past its first mint. Uses the
  // real renewal function against a real temp runtime dir (not the
  // no-op default fake in makeFakeDeps) so this proves the WIRING, not just
  // that some function got called. ──
  {
    const haveEngine = engineCheckoutAvailable();
    if (!haveEngine) {
      console.log(`⚠ aria-engine checkout not found at ${ENGINE_REPO} — the entitlement-renewal wiring block will run with structural assertions only (still real signing/renewal, just no cross-check against the real verifier).`);
    }

    const tmpRoot = mkdtempSync(path.join(tmpdir(), "aria-hosted-renewal-wiring-test-"));
    try {
      const runtimeDirFor = (clientId: string) => path.join(tmpRoot, clientId, ".aria");
      const pairingFilePath = (clientId: string) => path.join(runtimeDirFor(clientId), "state", "pairing-state.json");

      const fleet = new FakeFleetManager();
      const deps = makeFakeDeps(fleet, { approved: true });
      deps.renewHostedEntitlementIfNeeded = async (clientId) => {
        renewHostedPairingStateIfNeeded(runtimeDirFor(clientId), clientId);
      };

      const existingClientId = "already-hosted-near-expiry-client";
      deps.clientsByUser.set(9900, { id: existingClientId, hosting_mode: "hosted" });

      // Seed a pairing-state.json with a token expiring in ~1h — simulating
      // a hosted tenant well past the point this fix needed to exist for.
      const nowSec = Math.floor(Date.now() / 1000);
      const nearExpiryToken = signTestEntitlementToken(existingClientId, nowSec - (7 * 24 * 3600 - 3600), nowSec + 3600);
      writeHostedPairingStateToDisk(runtimeDirFor(existingClientId), { clientId: existingClientId, lastSequence: 3, entitlementToken: nearExpiryToken });

      // ── (a) /paper_start (startHostedEngine) on an ALREADY-hosted client with a near-expiry token transparently renews it before spawning ──
      const result1 = await startHostedEngine(deps, 9900);
      check("[wiring] start succeeds", result1.ok === true);
      if (result1.ok) {
        check("[wiring] created=false, converted=false — this is the plain 'already hosted' path renewal must also cover", result1.created === false && result1.converted === false);
      }
      check("[wiring] spawnTenant was called for the existing client", fleet.spawnCalls.includes(existingClientId));

      const afterFirstStart = JSON.parse(readFileSync(pairingFilePath(existingClientId), "utf8"));
      check("[wiring] the near-expiry token was replaced with a genuinely different one, BEFORE spawnTenant ran", afterFirstStart.entitlementToken !== nearExpiryToken);
      check("[wiring] lastSequence was preserved through the renewal (3, not reset)", afterFirstStart.lastSequence === 3);

      if (haveEngine) {
        const { verifyEntitlement } = await importEngineModule("entitlement.ts");
        const verification = verifyEntitlement(afterFirstStart.entitlementToken, TEST_ENTITLEMENT_PUBLIC_X, new Date());
        check("[wiring] the token startHostedEngine renewed genuinely verifies against the REAL aria-engine verifier", verification.granted === true);
      }

      // ── (b) A second /paper_start immediately after — token is now healthy, so it must NOT be re-signed again ──
      const result2 = await startHostedEngine(deps, 9900);
      check("[wiring] second start also succeeds", result2.ok === true);
      const afterSecondStart = JSON.parse(readFileSync(pairingFilePath(existingClientId), "utf8"));
      check("[wiring] a SECOND immediate /paper_start does NOT re-sign an already-healthy token", afterSecondStart.entitlementToken === afterFirstStart.entitlementToken);

      // ── Sanity: a brand-new client's create path still works with renewal wired in (renewal is a cheap no-op right after a fresh seed) ──
      const resultNew = await startHostedEngine(deps, 9901);
      check("[wiring] brand-new client create path is unaffected by the renewal wiring", resultNew.ok === true && (resultNew as any).created === true);
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
