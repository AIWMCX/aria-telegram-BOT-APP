/**
 * Hosted-PAPER reliability tests: durable desired state, rehydration after a
 * control-plane restart, graceful shutdownAll, /paper_start throttle, PAPER
 * wording, approval-revoke stop. Real FleetManager + the FAKE engine fixture
 * (never the real engine; scripts/packaged-engine-integration-test.mts does
 * the real-engine rehydration check).
 *
 * Run: npx tsx src/fleet/reliability.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FleetManager, FleetCapacityError, FleetShuttingDownError, type EngineInvocation, type TenantProcessHandle } from "./fleet-manager.js";
import { EngineIdentityError, type EngineIdentity } from "./engine-identity.js";
import { desiredStatePath, listDesiredRunning, readDesiredState, writeDesiredState, type FleetLogger } from "./desired-state.js";
import { TenantRehydrator, type RehydrationClientLike } from "./rehydrator.js";
import {
  StartThrottle,
  UNAVAILABLE_MESSAGE,
  formatHostedStatusMessage,
  handlePaperStatus,
  startHostedEngine,
  type HostedCommandsDeps,
} from "./hosted-commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "test-fixtures", "fake-engine.mjs");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reliab-"));
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function invocation(): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: [FIXTURE, "start"], cwd: __dirname }),
    buildStop: () => ({ command: process.execPath, args: [FIXTURE, "stop"], cwd: __dirname }),
    readyMarker: "paper engine started",
    testEnvPassthroughPrefixes: ["FAKE_"],
  };
}
function capLog(): FleetLogger & { lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> } {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  return {
    lines,
    info: (obj, msg) => void lines.push({ level: "info", obj, msg }),
    warn: (obj, msg) => void lines.push({ level: "warn", obj, msg }),
    error: (obj, msg) => void lines.push({ level: "error", obj, msg }),
  };
}
function makeFm(o: { tenantsRoot?: string; max?: number; verify?: () => EngineIdentity; log?: FleetLogger } = {}) {
  const tenantsRoot = o.tenantsRoot ?? tmp();
  const fm = new FleetManager({
    engineInvocation: invocation(),
    tenantsRoot,
    logsRoot: tmp(),
    ...(o.max !== undefined ? { maxConcurrentTenants: o.max } : {}),
    ...(o.verify ? { verifyEngineIdentity: o.verify } : {}),
    ...(o.log ? { log: o.log } : {}),
  });
  return { fm, tenantsRoot };
}
const client = (id: string, user = 1): RehydrationClientLike => ({ id, user_id: user, status: "active", hosting_mode: "hosted" });

function clearFake() {
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_CRASH_AFTER_MS;
  delete process.env.FAKE_FAIL_ON_START;
  delete process.env.FAKE_IGNORE_SIGTERM;
}

async function main() {
  clearFake();

  // ── 1. desired-state file: atomic write / validate / corrupt handling ──
  {
    const root = tmp();
    const log = capLog();
    writeDesiredState(root, "tenant-a", "running", 1234);
    const file = desiredStatePath(root, "tenant-a");
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    check("desired-state file has the documented shape", rec.version === 1 && rec.desired === "running" && rec.updatedAtMs === 1234);
    if (process.platform !== "win32") check("desired-state file mode is 0600", (fs.statSync(file).mode & 0o777) === 0o600);
    check("no temp file is left behind after an atomic write", fs.readdirSync(path.dirname(file)).every((f) => !f.endsWith(".tmp")));
    check("validated read returns the record", readDesiredState(root, "tenant-a", log)?.desired === "running");
    writeDesiredState(root, "tenant-a", "stopped");
    check("overwrite replaces the previous value", readDesiredState(root, "tenant-a")?.desired === "stopped");

    let threw = false;
    try {
      writeDesiredState(root, "../escape", "running");
    } catch {
      threw = true;
    }
    check("an invalid clientId is rejected BEFORE any path is built", threw && !fs.existsSync(path.join(root, "..", "escape")));

    fs.mkdirSync(path.join(root, "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(root, "corrupt", "desired-state.json"), "{not json");
    check("corrupt JSON is treated as absent (no throw)", readDesiredState(root, "corrupt", log) === undefined);
    check("corrupt JSON is logged", log.lines.some((l) => l.obj.clientId === "corrupt"));
    fs.mkdirSync(path.join(root, "weird"), { recursive: true });
    fs.writeFileSync(path.join(root, "weird", "desired-state.json"), JSON.stringify({ version: 1, desired: "exploding", updatedAtMs: 1 }));
    fs.mkdirSync(path.join(root, "oldver"), { recursive: true });
    fs.writeFileSync(path.join(root, "oldver", "desired-state.json"), JSON.stringify({ version: 2, desired: "running", updatedAtMs: 1 }));
    check("unknown desired value is treated as absent", readDesiredState(root, "weird") === undefined);
    check("unknown version is treated as absent", readDesiredState(root, "oldver") === undefined);

    writeDesiredState(root, "run-1", "running");
    writeDesiredState(root, "stop-1", "stopped");
    fs.mkdirSync(path.join(root, "bad name.x"), { recursive: true });
    fs.writeFileSync(path.join(root, "bad name.x", "desired-state.json"), JSON.stringify({ version: 1, desired: "running", updatedAtMs: 1 }));
    check("scan returns only valid-id dirs with desired=running", JSON.stringify(listDesiredRunning(root)) === JSON.stringify(["run-1"]));
  }

  // ── 2. write-before-act ordering ──
  {
    const { fm, tenantsRoot } = makeFm();
    await fm.spawnTenant("wba-1");
    check("spawn writes desired=running (file present while the process is alive)", readDesiredState(tenantsRoot, "wba-1")?.desired === "running");
    await fm.stopTenant("wba-1", true);
    check("stopTenant persists desired=stopped", readDesiredState(tenantsRoot, "wba-1")?.desired === "stopped");

    // If the intent cannot be recorded, nothing must be spawned.
    const blocked = makeFm();
    fs.writeFileSync(path.join(blocked.tenantsRoot, "wba-2"), "i am a file, so mkdir <root>/wba-2 fails");
    let spawnThrew = false;
    try {
      await blocked.fm.spawnTenant("wba-2");
    } catch {
      spawnThrew = true;
    }
    check("failed desired-state write aborts the spawn (no handle, no process)", spawnThrew && blocked.fm.getTenantStatus("wba-2") === undefined);

    // Stop with no live entry still persists (a queued-for-rehydration tenant).
    const q = makeFm();
    writeDesiredState(q.tenantsRoot, "queued-1", "running");
    await q.fm.stopTenant("queued-1", true);
    check("stop of a tenant with no handle still writes desired=stopped", q.fm.getDesiredState("queued-1") === "stopped");

    // Crash between the write and the spawn: only the file exists; a fresh
    // control plane (new FleetManager over the same root) recovers it.
    const crashRoot = tmp();
    writeDesiredState(crashRoot, "crash-gap", "running");
    const fresh = makeFm({ tenantsRoot: crashRoot });
    const rh = new TenantRehydrator({
      fleet: fresh.fm,
      getClientById: async (id) => client(id),
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
    });
    await rh.rehydrateTenants();
    check("crash between write and spawn is recovered by rehydration", await waitFor(() => fresh.fm.getTenantStatus("crash-gap")?.status === "running"));
    await fresh.fm.shutdownAll({ timeoutMs: 4000 });
  }

  // ── 3. rehydration ──
  {
    const root = tmp();
    for (const id of ["t-run1", "t-run2", "t-unapproved", "t-missing"]) writeDesiredState(root, id, "running");
    writeDesiredState(root, "t-stopped", "stopped");
    fs.mkdirSync(path.join(root, "bad name.x"), { recursive: true });
    fs.writeFileSync(path.join(root, "bad name.x", "desired-state.json"), JSON.stringify({ version: 1, desired: "running", updatedAtMs: 1 }));

    const { fm } = makeFm({ tenantsRoot: root });
    const spawnTimes: number[] = [];
    const origSpawn = fm.spawnTenant.bind(fm);
    const spawned: string[] = [];
    fm.spawnTenant = async (id: string) => {
      spawnTimes.push(Date.now());
      spawned.push(id);
      return origSpawn(id);
    };
    const renewOrder: Array<{ id: string; handleAtRenew: TenantProcessHandle | undefined }> = [];
    let inflight = 0;
    let maxInflight = 0;
    const rh = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => (id === "t-missing" ? undefined : client(id, id === "t-unapproved" ? 99 : 1)),
      isUserApproved: async (u) => u !== 99,
      renewHostedEntitlementIfNeeded: async (id) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        renewOrder.push({ id, handleAtRenew: fm.getTenantStatus(id) });
        await sleep(80);
        inflight--;
      },
      concurrency: 2,
      staggerMs: 120,
    });
    const t0 = Date.now();
    const done = rh.rehydrateTenants();
    check("rehydrateTenants is asynchronous (returns a promise, does not block)", done instanceof Promise && fm.getTenantStatus("t-run1") === undefined);
    await done;
    check("desired=running tenants are respawned", (await waitFor(() => fm.getTenantStatus("t-run1")?.status === "running")) && (await waitFor(() => fm.getTenantStatus("t-run2")?.status === "running")));
    check("stopped tenant is NOT spawned", !spawned.includes("t-stopped"));
    check("invalid directory names are ignored", !spawned.includes("bad name.x"));
    check("unapproved owner is NOT spawned and desired is set to stopped", !spawned.includes("t-unapproved") && fm.getDesiredState("t-unapproved") === "stopped");
    check("missing client row is NOT spawned and desired is set to stopped", !spawned.includes("t-missing") && fm.getDesiredState("t-missing") === "stopped");
    check("renewal ran BEFORE spawn for every spawned tenant", renewOrder.filter((r) => spawned.includes(r.id)).every((r) => r.handleAtRenew === undefined) && renewOrder.length >= 2);
    const gaps = spawnTimes.slice(1).map((t, i) => t - spawnTimes[i]!);
    check("spawns are staggered (>= ~100 ms apart)", gaps.length >= 1 && gaps.every((g) => g >= 100));
    check("concurrency never exceeds the bound (2)", maxInflight <= 2 && maxInflight >= 1);
    const c = rh.counts();
    check("counts report running tenants and nothing queued", c.running === 2 && c.queued === 0);
    check("counts are secret-free (only three numeric fields)", JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["queued", "restarting", "running"]));
    void t0;
    await fm.shutdownAll({ timeoutMs: 4000 });
  }

  // capacity cap + later fill via the periodic retry
  {
    const root = tmp();
    writeDesiredState(root, "cap-a", "running");
    writeDesiredState(root, "cap-b", "running");
    const log = capLog();
    const { fm } = makeFm({ tenantsRoot: root, max: 1, log });
    const rh = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => client(id),
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
      retryIntervalMs: 150,
      log,
    });
    await rh.rehydrateTenants();
    const first = ["cap-a", "cap-b"].find((i) => fm.getTenantStatus(i)?.status === "starting" || fm.getTenantStatus(i)?.status === "running")!;
    const second = first === "cap-a" ? "cap-b" : "cap-a";
    check("cap respected: exactly one tenant started", fm.getTenantStatus(second) === undefined);
    check("excess tenant keeps desired=running and is queued", fm.getDesiredState(second) === "running" && rh.counts().queued === 1);
    rh.startPeriodic();
    await sleep(500); // several ticks while still at capacity
    check("capacity condition is logged once, not per tick", log.lines.filter((l) => l.obj.reason === "capacity" && l.obj.clientId === second).length === 1);
    await fm.stopTenant(first, true);
    check("freed slot is filled by the periodic retry", await waitFor(() => fm.getTenantStatus(second)?.status === "running", 4000));
    rh.stop();
    await fm.shutdownAll({ timeoutMs: 4000 });
  }

  // engine unavailable keeps desired and retries; per-tenant failure isolation
  {
    const root = tmp();
    for (const id of ["eng-a", "eng-b"]) writeDesiredState(root, id, "running");
    let available = false;
    const log = capLog();
    const { fm } = makeFm({
      tenantsRoot: root,
      log,
      verify: () => ({ available, sha: null, mode: "paper", compatible: available, verified: available, enginePath: "(x)", reason: "down" }) as EngineIdentity,
    });
    const rh = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => client(id),
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
      log,
    });
    await rh.rehydrateTenants();
    await rh.rehydrateTenants();
    check("engine unavailable: desired stays running, nothing spawned", fm.getDesiredState("eng-a") === "running" && fm.getTenantStatus("eng-a") === undefined);
    check("engine unavailable is logged once per tenant across sweeps", log.lines.filter((l) => l.obj.reason === "engine-unavailable" && l.obj.clientId === "eng-a").length === 1);
    available = true;
    await rh.rehydrateTenants();
    check("engine becomes available: tenants start on the next sweep", await waitFor(() => fm.getTenantStatus("eng-a")?.status === "running" && fm.getTenantStatus("eng-b")?.status === "running"));
    await fm.shutdownAll({ timeoutMs: 4000 });

    const root2 = tmp();
    for (const id of ["iso-bad", "iso-good"]) writeDesiredState(root2, id, "running");
    const { fm: fm2 } = makeFm({ tenantsRoot: root2 });
    const rh2 = new TenantRehydrator({
      fleet: fm2,
      getClientById: async (id) => {
        if (id === "iso-bad") throw new Error("db blip");
        return client(id);
      },
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
    });
    await rh2.rehydrateTenants();
    check("one tenant's failure does not abort the sweep", await waitFor(() => fm2.getTenantStatus("iso-good")?.status === "running"));
    check("failed tenant keeps desired=running for retry", fm2.getDesiredState("iso-bad") === "running");
    await fm2.shutdownAll({ timeoutMs: 4000 });
  }

  // ── 4. /paper_status truthfulness ──
  {
    const restarting = formatHostedStatusMessage(undefined, { desiredRunning: true });
    const never = formatHostedStatusMessage(undefined, {});
    check("desired=running with no handle says 'Restarting after a service update'", restarting.includes("Restarting after a service update") && !restarting.includes("Never started"));
    check("restarting copy says PAPER", /PAPER/.test(restarting));
    check("no desired file and no handle still says 'Never started'", never.includes("Never started"));
    const sent: string[] = [];
    const deps = {
      fleetManager: { getTenantStatus: () => undefined, getDesiredState: () => "running", spawnTenant: async () => ({}) as never, stopTenant: async () => {} },
      getLatestActiveClientForUser: async () => ({ id: "c1", hosting_mode: "hosted" as const }),
      notify: async (_u: number, t: string) => void sent.push(t),
    } as unknown as HostedCommandsDeps;
    await handlePaperStatus(deps, { telegramUserId: 1, userId: 1 });
    check("handlePaperStatus uses the durable desired state", sent[0]!.includes("Restarting after a service update"));
  }

  // ── 5. graceful shutdownAll ──
  {
    const { fm, tenantsRoot } = makeFm({ max: 5 });
    const ids = ["sd-1", "sd-2", "sd-3"];
    for (const id of ids) await fm.spawnTenant(id);
    await waitFor(() => ids.every((id) => fm.getTenantStatus(id)?.status === "running"));
    const pids = ids.map((id) => fm.getTenantStatus(id)!.pid!);
    check("all tenant pids are alive before shutdown", pids.every(alive));
    const t0 = Date.now();
    const res = await fm.shutdownAll({ timeoutMs: 8000 });
    const elapsed = Date.now() - t0;
    check("shutdownAll finishes within the budget", elapsed < 8000);
    check("zero orphan processes (real pid probes)", pids.every((p) => !alive(p)) && res.remaining === 0);
    check("desired state is UNCHANGED by shutdown (still running)", ids.every((id) => readDesiredState(tenantsRoot, id)?.desired === "running"));
    let refused = false;
    try {
      await fm.spawnTenant("sd-4");
    } catch (e) {
      refused = e instanceof FleetShuttingDownError;
    }
    check("no new spawn is accepted once shutdown began", refused);

    // wedged engine: SIGTERM ignored -> SIGKILL escalation inside the budget
    process.env.FAKE_IGNORE_SIGTERM = "1";
    const w = makeFm();
    await w.fm.spawnTenant("wedged");
    await waitFor(() => w.fm.getTenantStatus("wedged")?.status === "running");
    const wpid = w.fm.getTenantStatus("wedged")!.pid!;
    delete process.env.FAKE_IGNORE_SIGTERM;
    const w0 = Date.now();
    const wres = await w.fm.shutdownAll({ timeoutMs: 2000 });
    check("SIGTERM-ignoring tenant is SIGKILLed within the budget", (process.platform === "win32" || wres.killed === 1) && wres.remaining === 0 && !alive(wpid) && Date.now() - w0 < 2000);

    const exitListeners = process.listenerCount("exit");
    makeFm();
    check("FleetManager has installed the process 'exit' orphan-kill hook (idempotently)", exitListeners >= 1 && process.listenerCount("exit") === exitListeners);
    // process 'exit' hook: parent exits without shutdownAll, child must die
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "test-fixtures", "exit-hook-parent.mts")], { encoding: "utf8", env: process.env });
    const m = /PID=(\d+)/.exec(r.stdout ?? "");
    const orphan = m ? Number(m[1]) : undefined;
    await sleep(300);
    check("process exit hook kills a child left behind (no orphan)", orphan !== undefined && !alive(orphan));
  }

  // ── 6. throttle ──
  {
    let now = 1_000_000;
    const th = new StartThrottle(15_000, 5, 600_000, () => now);
    check("first attempt allowed", th.waitMs(7) === 0);
    th.record(7);
    const w = th.waitMs(7);
    check("immediate retry is blocked ~15 s", w > 14_000 && w <= 15_000);
    check("another user is independent", th.waitMs(8) === 0);
    now += 16_000;
    check("allowed after the cooldown", th.waitMs(7) === 0);
    th.record(7);
    for (let i = 0; i < 3; i++) {
      now += 16_000;
      th.record(7);
    }
    now += 16_000;
    check("5 attempts in 10 min blocks the 6th for a long wait", th.waitMs(7) > 60_000);
    now += 600_000;
    check("window expiry re-allows", th.waitMs(7) === 0);

    const handles = new Map<string, TenantProcessHandle>();
    const spawnCalls: string[] = [];
    const throttle = new StartThrottle(15_000, 5, 600_000, () => now);
    const deps = {
      fleetManager: {
        getTenantStatus: (id: string) => handles.get(id),
        spawnTenant: async (id: string) => {
          spawnCalls.push(id);
          const h: TenantProcessHandle = { clientId: id, status: "running", restartCount: 0, consecutiveCrashes: 0 };
          handles.set(id, h);
          return h;
        },
        stopTenant: async () => {},
      },
      startThrottle: throttle,
      getLatestActiveClientForUser: async () => ({ id: "c-th", hosting_mode: "hosted" as const }),
      registerHostedClient: async () => ({ id: "c-th", hosting_mode: "hosted" as const }),
      convertClientToHosted: async () => {},
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      notify: async () => {},
    } as unknown as HostedCommandsDeps;
    const r1 = await startHostedEngine(deps, 50);
    check("first start ok", r1.ok);
    handles.set("c-th", { clientId: "c-th", status: "stopped", restartCount: 0, consecutiveCrashes: 0 });
    const r2 = await startHostedEngine(deps, 50);
    check("respawn after stopped inside the cooldown is throttled with a wait time", !r2.ok && r2.reason === "throttled" && /\d+ seconds/.test(r2.message) && spawnCalls.length === 1);
    handles.set("c-th", { clientId: "c-th", status: "running", restartCount: 0, consecutiveCrashes: 0 });
    const r3 = await startHostedEngine(deps, 50);
    check("start while already running is idempotent and never throttled", r3.ok && spawnCalls.length === 2);
    handles.set("c-th", { clientId: "c-th", status: "failed", restartCount: 5, consecutiveCrashes: 5 });
    const r4 = await startHostedEngine(deps, 50);
    check("respawn after failed is throttled too", !r4.ok && r4.reason === "throttled");
  }

  // ── 7. wording ──
  {
    const states: TenantProcessHandle["status"][] = ["starting", "running", "stopping", "stopped", "crashed", "failed"];
    const texts = states.map((status) => formatHostedStatusMessage({ clientId: "x", status, restartCount: 7, consecutiveCrashes: 4, lastExitCode: 137, startedAt: new Date().toISOString() }));
    texts.push(formatHostedStatusMessage(undefined, { desiredRunning: true }));
    check("every state's copy says PAPER", texts.every((t) => /PAPER/.test(t)));
    check("no internal exit code / restart count / crash count in user text", texts.every((t) => !/exit code|total restarts|137|consecutive/i.test(t)));
    check("crashed/failed copy says PAPER explicitly", /PAPER/.test(texts[4]!) && /PAPER/.test(texts[5]!));
    const id: EngineIdentity = { available: false, sha: null, mode: "paper", compatible: false, verified: false, enginePath: "/opt/secret/path", reason: "boom" } as EngineIdentity;
    const deps = {
      fleetManager: { getTenantStatus: () => undefined, spawnTenant: async () => { throw new EngineIdentityError("abc-123-client", id); }, stopTenant: async () => {} },
      getLatestActiveClientForUser: async () => ({ id: "abc-123-client", hosting_mode: "hosted" as const }),
      registerHostedClient: async () => ({ id: "abc-123-client", hosting_mode: "hosted" as const }),
      convertClientToHosted: async () => {},
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      notify: async () => {},
    } as unknown as HostedCommandsDeps;
    const r = await startHostedEngine(deps, 1);
    check("engine unavailable => the clear 'not available right now' message", !r.ok && r.reason === "unavailable" && r.message === UNAVAILABLE_MESSAGE);
    check("unavailable message leaks no internals (ids/paths/sha)", !r.ok && !/abc-123|\/opt|boom|Error|\.ts/.test(r.message));
    void FleetCapacityError;
  }

  // ── 8. approval revoke stops the tenant ──
  {
    const root = tmp();
    const { fm } = makeFm({ tenantsRoot: root });
    for (const id of ["rv-keep", "rv-revoked", "rv-blip"]) await fm.spawnTenant(id);
    await waitFor(() => ["rv-keep", "rv-revoked", "rv-blip"].every((i) => fm.getTenantStatus(i)?.status === "running"));
    const rh = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => {
        if (id === "rv-blip") throw new Error("transient");
        return client(id, id === "rv-revoked" ? 66 : 1);
      },
      isUserApproved: async (u) => u !== 66,
      renewHostedEntitlementIfNeeded: async () => {},
    });
    await rh.checkApprovals();
    check("revoked user's running tenant is stopped", fm.getTenantStatus("rv-revoked")?.status === "stopped");
    check("revoke writes desired=stopped (won't come back after a restart)", fm.getDesiredState("rv-revoked") === "stopped");
    check("approved tenant is untouched", fm.getTenantStatus("rv-keep")?.status === "running" && fm.getDesiredState("rv-keep") === "running");
    check("a transient lookup error never stops a tenant", fm.getTenantStatus("rv-blip")?.status === "running");
    await fm.shutdownAll({ timeoutMs: 4000 });
  }

  // ── 9. review follow-ups (F1-F5) ──
  const rhBase = (fm: FleetManager, extra: Partial<ConstructorParameters<typeof TenantRehydrator>[0]> = {}) =>
    new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => client(id),
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
      ...extra,
    });

  // F1: /paper_stop landing while processOne awaits must NOT be undone.
  {
    const root = tmp();
    writeDesiredState(root, "race-1", "running");
    const { fm } = makeFm({ tenantsRoot: root });
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rh = rhBase(fm, {
      getClientById: async (id) => {
        entered();
        await gate;
        return client(id);
      },
    });
    const sweep = rh.rehydrateTenants();
    await enteredP;
    await fm.stopTenant("race-1", true); // user stops while the sweep is paused in the DB await
    release();
    await sweep;
    check("F1: stop during rehydration's await is not undone (no spawn)", fm.getTenantStatus("race-1") === undefined);
    check("F1: desired stays stopped", fm.getDesiredState("race-1") === "stopped");
    check("F1: tenant is no longer pending", !rh.isPending("race-1"));

    // revoke landing mid-processOne (after the first approval check)
    const root2 = tmp();
    writeDesiredState(root2, "race-2", "running");
    const { fm: fm2 } = makeFm({ tenantsRoot: root2 });
    let approved = true;
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    let renewEntered!: () => void;
    const renewP = new Promise<void>((r) => (renewEntered = r));
    const rh2 = rhBase(fm2, {
      isUserApproved: async () => approved,
      renewHostedEntitlementIfNeeded: async () => {
        renewEntered();
        await gate2;
      },
    });
    const sweep2 = rh2.rehydrateTenants();
    await renewP;
    approved = false; // revoked while renewal is in flight
    release2();
    await sweep2;
    check("F1: revoke mid-processOne prevents the spawn", fm2.getTenantStatus("race-2") === undefined && fm2.getDesiredState("race-2") === "stopped");
  }

  // F2: crashed tenants are covered by checkApprovals; the restart timer re-checks desired state.
  {
    process.env.FAKE_FAIL_ON_START = "1";
    const a = new FleetManager({ engineInvocation: invocation(), tenantsRoot: tmp(), logsRoot: tmp(), restartBackoffMs: 60_000 });
    await a.spawnTenant("cr-1");
    await waitFor(() => a.getTenantStatus("cr-1")?.status === "crashed");
    delete process.env.FAKE_FAIL_ON_START;
    const rhA = rhBase(a, { isUserApproved: async () => false });
    await rhA.checkApprovals();
    check("F2: checkApprovals stops a crashed (restart-pending) tenant whose approval was revoked", a.getTenantStatus("cr-1")?.status === "stopped" && a.getDesiredState("cr-1") === "stopped");

    process.env.FAKE_FAIL_ON_START = "1";
    const b = new FleetManager({ engineInvocation: invocation(), tenantsRoot: tmp(), logsRoot: tmp(), restartBackoffMs: 200 });
    await b.spawnTenant("cr-2");
    await waitFor(() => b.getTenantStatus("cr-2")?.status === "crashed");
    delete process.env.FAKE_FAIL_ON_START; // a relaunch would now SUCCEED, so a wrongly-fired timer is visible
    b.setDesiredState("cr-2", "stopped");
    await sleep(800);
    check("F2: pending restart timer does not relaunch a tenant whose desired state is stopped", b.getTenantStatus("cr-2")?.status === "stopped" && b.getTenantStatus("cr-2")?.pid === undefined);
  }

  // F3: bounded retries for permanent-looking failures; honest status afterwards.
  {
    const root = tmp();
    writeDesiredState(root, "perm-1", "running");
    const { fm } = makeFm({ tenantsRoot: root });
    const log = capLog();
    let renewCalls = 0;
    const rh = rhBase(fm, {
      renewHostedEntitlementIfNeeded: async () => {
        renewCalls++;
        throw new Error("permanent");
      },
      maxFailureAttempts: 3,
      failureBackoffMs: 0,
      log,
    });
    for (let i = 0; i < 6; i++) await rh.rehydrateTenants();
    check("F3: stops retrying after N attempts (renewal called exactly 3 times)", renewCalls === 3);
    check("F3: gave up is recorded, desired stays running, not pending", rh.hasGivenUp("perm-1") && fm.getDesiredState("perm-1") === "running" && !rh.isPending("perm-1"));
    check("F3: giving up is logged exactly once", log.lines.filter((l) => /giving up/.test(l.msg)).length === 1);
    const msg = formatHostedStatusMessage(undefined, { desiredRunning: true, gaveUp: true });
    check("F3: status says it needs attention / use /paper_start, not 'no action needed'", /Needs attention/.test(msg) && /paper_start/.test(msg) && !/no action needed/.test(msg) && /PAPER/.test(msg));
    const sent: string[] = [];
    await handlePaperStatus(
      {
        fleetManager: { getTenantStatus: () => undefined, getDesiredState: () => "running", spawnTenant: async () => ({}) as never, stopTenant: async () => {} },
        rehydrationState: (id: string) => (rh.hasGivenUp(id) ? "gave_up" : undefined),
        getLatestActiveClientForUser: async () => ({ id: "perm-1", hosting_mode: "hosted" as const }),
        notify: async (_u: number, t: string) => void sent.push(t),
      } as unknown as HostedCommandsDeps,
      { telegramUserId: 1, userId: 1 },
    );
    check("F3: handlePaperStatus surfaces the gave-up state", /Needs attention/.test(sent[0] ?? ""));

    // backoff: a failed tenant is not retried again inside its backoff window
    const root2 = tmp();
    writeDesiredState(root2, "perm-2", "running");
    const { fm: fm2 } = makeFm({ tenantsRoot: root2 });
    let calls2 = 0;
    const rh2 = rhBase(fm2, {
      renewHostedEntitlementIfNeeded: async () => {
        calls2++;
        throw new Error("x");
      },
      failureBackoffMs: 60_000,
    });
    await rh2.rehydrateTenants();
    await rh2.rehydrateTenants();
    check("F3: per-tenant backoff skips an immediate retry", calls2 === 1);
  }

  // F4: SIGKILL escalation, platform-independent (fake tenant process, no OS signals involved).
  {
    const mkFake = (exitsOnSigterm: boolean) => {
      const signals: string[] = [];
      const listeners: Array<(e: unknown) => void> = [];
      const tp = {
        hasExited: false,
        child: { kill() {} },
        signal(sig: string) {
          signals.push(sig);
          if (sig === "SIGKILL" || (sig === "SIGTERM" && exitsOnSigterm)) {
            tp.hasExited = true;
            for (const l of listeners) l({ type: "exit", code: null, signal: sig });
          }
        },
        onEvent(l: (e: unknown) => void) {
          listeners.push(l);
        },
      };
      return { tp, signals };
    };
    const wedged = mkFake(false);
    const { fm } = makeFm();
    (fm as unknown as { tenants: Map<string, unknown> }).tenants.set("fk-1", {
      handle: { clientId: "fk-1", status: "running", restartCount: 0, consecutiveCrashes: 0 },
      process: wedged.tp,
    });
    const t0 = Date.now();
    const res = await fm.shutdownAll({ timeoutMs: 400 });
    check("F4: a SIGTERM-ignoring tenant gets SIGTERM then SIGKILL", JSON.stringify(wedged.signals) === JSON.stringify(["SIGTERM", "SIGKILL"]));
    check("F4: escalation is reported and nothing remains, within the budget", res.killed === 1 && res.remaining === 0 && Date.now() - t0 < 700);
    const polite = mkFake(true);
    const { fm: fm2 } = makeFm();
    (fm2 as unknown as { tenants: Map<string, unknown> }).tenants.set("fk-2", {
      handle: { clientId: "fk-2", status: "running", restartCount: 0, consecutiveCrashes: 0 },
      process: polite.tp,
    });
    const res2 = await fm2.shutdownAll({ timeoutMs: 400 });
    check("F4: a cooperative tenant is never SIGKILLed", JSON.stringify(polite.signals) === JSON.stringify(["SIGTERM"]) && res2.killed === 0);
  }

  // F5: rehydrator's own guards (stopped desired, shutting down, stopped rehydrator).
  {
    const root = tmp();
    writeDesiredState(root, "g-1", "running");
    writeDesiredState(root, "g-2", "running");
    const { fm } = makeFm({ tenantsRoot: root });
    const calls: string[] = [];
    const rh = rhBase(fm, {
      concurrency: 1,
      staggerMs: 150,
      getClientById: async (id) => {
        calls.push(id);
        if (id === "g-1") fm.setDesiredState("g-2", "stopped"); // flips while g-2 is queued
        return client(id);
      },
    });
    await rh.rehydrateTenants();
    check("F5: a tenant whose desired state flipped to stopped while queued is skipped before any lookup", !calls.includes("g-2") && fm.getTenantStatus("g-2") === undefined);
    await fm.shutdownAll({ timeoutMs: 3000 });

    const root2 = tmp();
    for (const id of ["s-1", "s-2", "s-3"]) writeDesiredState(root2, id, "running");
    const { fm: fm2 } = makeFm({ tenantsRoot: root2 });
    const calls2: string[] = [];
    let sd: Promise<unknown> | undefined;
    const rh2 = rhBase(fm2, {
      concurrency: 1,
      staggerMs: 150,
      getClientById: async (id) => {
        calls2.push(id);
        if (id === "s-1") sd = fm2.shutdownAll({ timeoutMs: 2000 });
        return client(id);
      },
    });
    await rh2.rehydrateTenants();
    await sd;
    check("F5: once shutdown began, the sweep stops processing further tenants", JSON.stringify(calls2) === JSON.stringify(["s-1"]));

    const root3 = tmp();
    const { fm: fm3 } = makeFm({ tenantsRoot: root3 });
    await fm3.spawnTenant("st-1");
    await waitFor(() => fm3.getTenantStatus("st-1")?.status === "running");
    let lookups = 0;
    const rh3 = rhBase(fm3, {
      getClientById: async (id) => {
        lookups++;
        return client(id);
      },
      isUserApproved: async () => false,
    });
    rh3.stop();
    await rh3.checkApprovals();
    writeDesiredState(root3, "st-2", "running");
    await rh3.rehydrateTenants();
    check("F5: a stopped rehydrator neither re-checks approvals nor sweeps", lookups === 0 && fm3.getTenantStatus("st-1")?.status === "running" && fm3.getTenantStatus("st-2") === undefined);
    await fm3.shutdownAll({ timeoutMs: 3000 });
  }

  // Throttle memory: empty keys are not retained.
  {
    let now = 5_000_000;
    const th = new StartThrottle(15_000, 5, 600_000, () => now);
    th.record(1);
    th.record(2);
    now += 700_000;
    th.waitMs(1);
    check("throttle drops a user's key once their attempts leave the window", th.size() === 1);
    th.prune();
    check("throttle prune() clears fully expired users", th.size() === 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall reliability checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
