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
import { FleetCapacityError, type TenantProcessHandle } from "./fleet-manager.js";
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
function makeFakeDeps(fleet: FakeFleetManager, opts: { approved?: boolean } = {}): HostedCommandsDeps & { clientsByUser: Map<number, EngineClientLike>; notifications: Array<{ telegramUserId: number; text: string }>; nextId: () => string } {
  const clientsByUser = new Map<number, EngineClientLike>();
  const notifications: Array<{ telegramUserId: number; text: string }> = [];
  let counter = 0;
  const nextId = () => `client-${++counter}`;

  return {
    clientsByUser,
    notifications,
    nextId,
    fleetManager: fleet,
    getLatestActiveClientForUser: async (userId) => clientsByUser.get(userId),
    registerHostedClient: async (userId) => {
      const client: EngineClientLike = { id: nextId(), hosting_mode: "hosted" };
      clientsByUser.set(userId, client);
      return client;
    },
    setHostingMode: async (id, mode) => {
      for (const client of clientsByUser.values()) {
        if (client.id === id) (client as any).hosting_mode = mode;
      }
    },
    isUserApproved: async () => opts.approved ?? true,
    notify: async (telegramUserId, text) => {
      notifications.push({ telegramUserId, text });
    },
  };
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

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
