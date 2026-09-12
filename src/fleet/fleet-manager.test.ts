/**
 * FleetManager state-machine tests against the FAKE fixture
 * (test-fixtures/fake-engine.mjs) — never the real aria-engine CLI here;
 * that's fleet-manager.integration.test.ts's job.
 *
 * Same hand-rolled convention as the rest of this repo's tests
 * (test/e2e.ts etc.): no test framework, `check()` counts failures,
 * process exits nonzero if any failed.
 *
 * Run: npx tsx src/fleet/fleet-manager.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FleetManager, type EngineInvocation } from "./fleet-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "test-fixtures", "fake-engine.mjs");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function freshTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
  return root;
}

function fakeInvocation(extraEnv: Record<string, string> = {}): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: [FIXTURE, "start"], cwd: __dirname }),
    buildStop: () => ({ command: process.execPath, args: [FIXTURE, "stop"], cwd: __dirname }),
    readyMarker: "paper engine started",
  };
}

// tiny helper: fold extraEnv into process.env for the fake's own process before spawn is unnecessary
// since our FleetManager doesn't expose per-tenant extraEnv beyond ARIA_RUNTIME_DIR; instead we set
// FAKE_* vars via process.env before each spawnTenant call in the tests that need crash behavior.

async function main() {
  // ── spawning creates a tracked handle: starting -> running ──────────
  {
    delete process.env.FAKE_EXIT_CODE;
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_FAIL_ON_START;
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot });

    const handle = await fm.spawnTenant("tenant-a");
    check("initial status is starting or already running (fast fixture)", handle.status === "starting" || handle.status === "running");
    check("pid is set immediately after spawn", typeof handle.pid === "number");

    const becameRunning = await waitFor(() => fm.getTenantStatus("tenant-a")?.status === "running");
    check("transitions to running once the ready marker is seen", becameRunning);

    const runtimeDir = path.join(tenantsRoot, "tenant-a", ".aria");
    check("tenant-scoped runtime dir was created", fs.existsSync(runtimeDir));
    check("tenant-scoped lock file exists", fs.existsSync(path.join(runtimeDir, "lock")));

    await fm.stopTenant("tenant-a", true);
    check("stopTenant resolves once the process has exited", fm.getTenantStatus("tenant-a")?.status === "stopped");
    check("lock file is cleared on graceful stop", !fs.existsSync(path.join(runtimeDir, "lock")));
  }

  // ── graceful stop uses the desired-state mechanism, not a raw kill ──
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, gracefulStopTimeoutMs: 2000, sigtermTimeoutMs: 1000 });
    await fm.spawnTenant("tenant-b");
    await waitFor(() => fm.getTenantStatus("tenant-b")?.status === "running");
    const pidBefore = fm.getTenantStatus("tenant-b")?.pid;

    const t0 = Date.now();
    await fm.stopTenant("tenant-b", true);
    const elapsed = Date.now() - t0;
    check("graceful stop converges well under the SIGTERM fallback timeout (proves desired-state path worked, not the kill fallback)", elapsed < 1000);
    check("handle reflects stopped", fm.getTenantStatus("tenant-b")?.status === "stopped");
    check("pid was assigned before stop (sanity)", typeof pidBefore === "number");
  }

  // ── crash -> restart with backoff, restartCount increments ─────────
  {
    process.env.FAKE_CRASH_AFTER_MS = "150";
    process.env.FAKE_EXIT_CODE = "7";
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, restartBackoffMs: 300 });
    await fm.spawnTenant("tenant-crash");
    await waitFor(() => fm.getTenantStatus("tenant-crash")?.status === "running");

    const sawCrashed = await waitFor(() => fm.getTenantStatus("tenant-crash")?.status === "crashed", 1000);
    check("unexpected exit transitions to crashed", sawCrashed);
    check("lastExitCode captured from the crash", fm.getTenantStatus("tenant-crash")?.lastExitCode === 7);

    // Should NOT have restarted yet immediately (backoff not instant).
    await sleep(50);
    check("does not restart-loop instantly (still crashed shortly after)", fm.getTenantStatus("tenant-crash")?.status === "crashed");

    const restarted = await waitFor(() => fm.getTenantStatus("tenant-crash")?.status === "running", 2000);
    check("restarts automatically after the backoff window", restarted);
    check("restartCount incremented exactly once", fm.getTenantStatus("tenant-crash")?.restartCount === 1);

    await fm.stopTenant("tenant-crash", false);
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_EXIT_CODE;
  }

  // ── double-spawn on an already-running tenant is a no-op returning the same handle ──
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot });
    const h1 = await fm.spawnTenant("tenant-dup");
    await waitFor(() => fm.getTenantStatus("tenant-dup")?.status === "running");
    const pidAfterFirstRunning = fm.getTenantStatus("tenant-dup")?.pid;
    const h2 = await fm.spawnTenant("tenant-dup");
    check("double spawnTenant on a running tenant returns the SAME handle object (no-op, not a second process)", h1 === h2);
    check("pid unchanged after the redundant spawn call", fm.getTenantStatus("tenant-dup")?.pid === pidAfterFirstRunning);
    await fm.stopTenant("tenant-dup", true);
  }

  // ── spawnTenant while stopping is rejected, not silently queued ─────
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, gracefulStopTimeoutMs: 1500 });
    await fm.spawnTenant("tenant-race");
    await waitFor(() => fm.getTenantStatus("tenant-race")?.status === "running");
    const stopP = fm.stopTenant("tenant-race", true);
    let rejected = false;
    try {
      await fm.spawnTenant("tenant-race");
    } catch {
      rejected = true;
    }
    check("spawnTenant while a stop is in flight is rejected", rejected);
    await stopP;
  }

  // ── stopTenant on a never-spawned / already-stopped tenant is a safe no-op ──
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot });
    let threw = false;
    try {
      await fm.stopTenant("never-existed", true);
    } catch {
      threw = true;
    }
    check("stopTenant on an unknown clientId does not throw", !threw);
    check("stopTenant on an unknown clientId leaves no tracked handle", fm.getTenantStatus("never-existed") === undefined);

    await fm.spawnTenant("tenant-double-stop");
    await waitFor(() => fm.getTenantStatus("tenant-double-stop")?.status === "running");
    await fm.stopTenant("tenant-double-stop", true);
    let secondThrew = false;
    try {
      await fm.stopTenant("tenant-double-stop", true);
    } catch {
      secondThrew = true;
    }
    check("calling stopTenant twice on an already-stopped tenant does not throw", !secondThrew);
  }

  // ── listActiveTenants / getTenantStatus basic contract ──────────────
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot });
    check("listActiveTenants starts empty", fm.listActiveTenants().length === 0);
    await fm.spawnTenant("tenant-list");
    await waitFor(() => fm.getTenantStatus("tenant-list")?.status === "running");
    check("listActiveTenants includes a running tenant", fm.listActiveTenants().some((h) => h.clientId === "tenant-list"));
    await fm.stopTenant("tenant-list", true);
    check("listActiveTenants excludes a stopped tenant", !fm.listActiveTenants().some((h) => h.clientId === "tenant-list"));
  }

  // ── ISOLATION (mandatory, per Global Constraints): one tenant's external
  // kill -9 must not affect a sibling tenant or the Fleet Manager itself ──
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, restartBackoffMs: 250 });

    await fm.spawnTenant("victim");
    await fm.spawnTenant("survivor");
    await waitFor(() => fm.getTenantStatus("victim")?.status === "running");
    await waitFor(() => fm.getTenantStatus("survivor")?.status === "running");

    const victimPidBefore = fm.getTenantStatus("victim")?.pid!;
    const survivorPid = fm.getTenantStatus("survivor")?.pid!;

    // Deliberately misbehave "victim" from OUTSIDE FleetManager's own
    // stopTenant() path — a real external SIGKILL, exactly like an OOM
    // kill or a manual `kill -9` on a runaway tenant process would be.
    process.kill(victimPidBefore, "SIGKILL");

    const victimCrashed = await waitFor(() => fm.getTenantStatus("victim")?.status === "crashed", 2000);
    check("the killed tenant is detected as crashed", victimCrashed);

    // The survivor must show ZERO effect: same pid, still running, no restart.
    await sleep(300);
    check("the OTHER tenant's process is completely unaffected: still running", fm.getTenantStatus("survivor")?.status === "running");
    check("the OTHER tenant's pid is unchanged (it was never touched)", fm.getTenantStatus("survivor")?.pid === survivorPid);
    check("the OTHER tenant's restartCount is untouched", fm.getTenantStatus("survivor")?.restartCount === 0);

    // The Fleet Manager itself must be unaffected: still able to service
    // new spawns/stops after a sibling's violent death.
    let fmStillFunctional = false;
    try {
      const h = await fm.spawnTenant("post-kill-newcomer");
      fmStillFunctional = h.clientId === "post-kill-newcomer";
    } catch {
      fmStillFunctional = false;
    }
    check("the Fleet Manager itself remains fully functional after a sibling's SIGKILL (can still spawn new tenants)", fmStillFunctional);

    // The killed tenant should still recover via the normal crash-restart policy.
    const victimRecovered = await waitFor(() => fm.getTenantStatus("victim")?.status === "running", 2000);
    check("the killed tenant recovers via the same restart-backoff policy as any other crash", victimRecovered);
    check("the killed tenant's restartCount incremented", (fm.getTenantStatus("victim")?.restartCount ?? 0) >= 1);

    await fm.stopTenant("victim", true);
    await fm.stopTenant("survivor", true);
    await fm.stopTenant("post-kill-newcomer", true);
  }

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fleet-manager.test.ts crashed:", err);
  process.exit(1);
});
