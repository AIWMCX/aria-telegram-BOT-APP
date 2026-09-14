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
import { FleetManager, FleetCapacityError, type EngineInvocation } from "./fleet-manager.js";

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

  // ── REGRESSION (reviewer-found race, commit fdb4796 review fix): calling
  // stopTenant() during the crashed/pending-restart window must actually
  // cancel the scheduled restart, not silently no-op and let it fire ──
  {
    process.env.FAKE_CRASH_AFTER_MS = "100";
    process.env.FAKE_EXIT_CODE = "9";
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const restartBackoffMs = 300;
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, restartBackoffMs });
    await fm.spawnTenant("tenant-stop-during-crash");
    await waitFor(() => fm.getTenantStatus("tenant-stop-during-crash")?.status === "running");

    const sawCrashed = await waitFor(() => fm.getTenantStatus("tenant-stop-during-crash")?.status === "crashed", 1000);
    check("regression setup: tenant reaches crashed state", sawCrashed);

    // Call stopTenant() WHILE the restart is pending (well inside the
    // restartBackoffMs window) — this is exactly the reviewer's reproduced
    // timeline: stopTenant() must not return as a no-op that leaves the
    // scheduled restart armed.
    await fm.stopTenant("tenant-stop-during-crash", true);
    check("stopTenant() resolves with status stopped, not left crashed", fm.getTenantStatus("tenant-stop-during-crash")?.status === "stopped");

    // Now wait PAST what would have been the restart time (backoff + margin)
    // and assert the tenant is genuinely stopped with no live process — the
    // pre-fix code would have let the pending restartTimer fire here and
    // resurrect a new process (status flips to "starting"/"running" again,
    // exactly the reviewer's `+600ms status: starting` / `+800ms status:
    // running` timeline), which this assertion catches.
    await sleep(restartBackoffMs + 400);
    check(
      "no resurrection: tenant is still stopped well past the original backoff window",
      fm.getTenantStatus("tenant-stop-during-crash")?.status === "stopped",
    );
    check("no resurrection: pid was cleared and not reassigned", fm.getTenantStatus("tenant-stop-during-crash")?.pid === undefined);
    check(
      "restartCount did not increment (no restart actually happened after the stop)",
      fm.getTenantStatus("tenant-stop-during-crash")?.restartCount === 0,
    );

    // Calling stopTenant() again after the fix already stopped a crashed
    // tenant must remain a safe no-op (guards against reintroducing a
    // different bug while fixing this one).
    let secondCallThrew = false;
    try {
      await fm.stopTenant("tenant-stop-during-crash", true);
    } catch {
      secondCallThrew = true;
    }
    check("calling stopTenant() again after it already stopped a crashed tenant is a safe no-op", !secondCallThrew);
    check("status remains stopped after the redundant second stopTenant() call", fm.getTenantStatus("tenant-stop-during-crash")?.status === "stopped");

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
    const survivorLogPath = path.join(logsRoot, "survivor.log");
    const survivorLogBefore = fs.readFileSync(survivorLogPath, "utf8");

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

    // Reviewer's secondary finding: checking only FleetManager's in-memory
    // bookkeeping proves nothing about the ACTUAL OS process. Send signal 0
    // to the survivor's real pid — this sends no signal, but throws if no
    // process with that pid exists, giving a genuine OS-level liveness check.
    let survivorReallyAlive = true;
    try {
      process.kill(survivorPid, 0);
    } catch {
      survivorReallyAlive = false;
    }
    check("the survivor's REAL OS process is still alive (OS-level check, not just in-memory status)", survivorReallyAlive);

    // Also confirm the survivor's own log file (its tenant-scoped runtime
    // artifact) was not touched/modified by the victim's crash.
    const survivorLogAfter = fs.readFileSync(survivorLogPath, "utf8");
    check("the survivor's log file was not touched by the victim's crash", survivorLogAfter === survivorLogBefore);

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

  // ── LOG CROSS-CONTAMINATION: two tenants, each with a distinctive stdout
  // line, must each end up ONLY in their own log file, never the other's ──
  {
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot });

    process.env.FAKE_EXTRA_LINE = "DISTINCTIVE-LINE-FOR-tenant-log-a";
    await fm.spawnTenant("tenant-log-a");
    await waitFor(() => fm.getTenantStatus("tenant-log-a")?.status === "running");

    process.env.FAKE_EXTRA_LINE = "DISTINCTIVE-LINE-FOR-tenant-log-b";
    await fm.spawnTenant("tenant-log-b");
    await waitFor(() => fm.getTenantStatus("tenant-log-b")?.status === "running");
    delete process.env.FAKE_EXTRA_LINE;

    await fm.stopTenant("tenant-log-a", true);
    await fm.stopTenant("tenant-log-b", true);

    const logA = fs.readFileSync(path.join(logsRoot, "tenant-log-a.log"), "utf8");
    const logB = fs.readFileSync(path.join(logsRoot, "tenant-log-b.log"), "utf8");

    check("tenant-log-a's log contains its own distinctive line", logA.includes("DISTINCTIVE-LINE-FOR-tenant-log-a"));
    check("tenant-log-a's log does NOT contain tenant-log-b's line", !logA.includes("DISTINCTIVE-LINE-FOR-tenant-log-b"));
    check("tenant-log-b's log contains its own distinctive line", logB.includes("DISTINCTIVE-LINE-FOR-tenant-log-b"));
    check("tenant-log-b's log does NOT contain tenant-log-a's line", !logB.includes("DISTINCTIVE-LINE-FOR-tenant-log-a"));
  }

  // ── TASK 3: max concurrent tenant count is enforced, not silently dropped ──
  {
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_EXIT_CODE;
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, maxConcurrentTenants: 2 });

    await fm.spawnTenant("cap-1");
    await fm.spawnTenant("cap-2");
    await waitFor(() => fm.getTenantStatus("cap-1")?.status === "running");
    await waitFor(() => fm.getTenantStatus("cap-2")?.status === "running");

    let capacityError: unknown;
    try {
      await fm.spawnTenant("cap-3");
    } catch (err) {
      capacityError = err;
    }
    check("spawning past maxConcurrentTenants is rejected, not silently dropped", capacityError instanceof FleetCapacityError);
    check("the capacity error names the offending clientId", (capacityError as FleetCapacityError)?.clientId === "cap-3");
    check("the capacity error names the configured limit", (capacityError as FleetCapacityError)?.limit === 2);
    check("cap-3 was never tracked (a rejected spawn leaves no dangling handle)", fm.getTenantStatus("cap-3") === undefined);

    // Stopping one tenant must free a slot for a new spawn.
    await fm.stopTenant("cap-1", true);
    check("stopping cap-1 frees a slot (status is stopped)", fm.getTenantStatus("cap-1")?.status === "stopped");

    let thirdSpawnOk = false;
    try {
      const h = await fm.spawnTenant("cap-3");
      thirdSpawnOk = h.clientId === "cap-3";
    } catch {
      thirdSpawnOk = false;
    }
    check("after freeing a slot, a new tenant can be spawned", thirdSpawnOk);
    await waitFor(() => fm.getTenantStatus("cap-3")?.status === "running");
    check("the newly-spawned tenant reaches running", fm.getTenantStatus("cap-3")?.status === "running");

    await fm.stopTenant("cap-2", true);
    await fm.stopTenant("cap-3", true);
  }

  // ── TASK 3: crash-loop exponential backoff escalates, then gives up
  // after maxConsecutiveCrashes and stops auto-restarting entirely ──────
  {
    process.env.FAKE_CRASH_AFTER_MS = "20";
    process.env.FAKE_EXIT_CODE = "5";
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({
      engineInvocation: fakeInvocation(),
      tenantsRoot,
      logsRoot,
      restartBackoffMs: 40,
      maxRestartBackoffMs: 5000,
      sustainedHealthyMs: 100000, // effectively "never" for this fast-crash test — no accidental reset
      maxConsecutiveCrashes: 3,
    });

    await fm.spawnTenant("loop-tenant");

    const firstCrash = await waitFor(() => fm.getTenantStatus("loop-tenant")?.status === "crashed", 2000);
    check("first crash reaches crashed status", firstCrash);
    check("consecutiveCrashes is 1 after the first crash", fm.getTenantStatus("loop-tenant")?.consecutiveCrashes === 1);

    const secondCrash = await waitFor(
      () => (fm.getTenantStatus("loop-tenant")?.consecutiveCrashes ?? 0) >= 2 && fm.getTenantStatus("loop-tenant")?.status === "crashed",
      3000,
    );
    check("backoff doubles: second crash observed with consecutiveCrashes=2", secondCrash);
    check("restartCount reflects one completed restart before the second crash", (fm.getTenantStatus("loop-tenant")?.restartCount ?? 0) >= 1);

    const gaveUp = await waitFor(() => fm.getTenantStatus("loop-tenant")?.status === "failed", 4000);
    check("after maxConsecutiveCrashes (3), tenant transitions to the terminal 'failed' status", gaveUp);
    check("consecutiveCrashes reached the configured maxConsecutiveCrashes", fm.getTenantStatus("loop-tenant")?.consecutiveCrashes === 3);

    // Must NOT keep restarting from here — confirm no further activity for
    // several multiples of what the (already-capped) backoff would have been.
    const restartCountAtGiveUp = fm.getTenantStatus("loop-tenant")?.restartCount;
    await sleep(500);
    check("status remains 'failed' (no further auto-restart attempts)", fm.getTenantStatus("loop-tenant")?.status === "failed");
    check("restartCount did not change after giving up", fm.getTenantStatus("loop-tenant")?.restartCount === restartCountAtGiveUp);

    // stopTenant on a 'failed' tenant is a safe no-op that leaves status as 'failed'.
    let stopThrew = false;
    try {
      await fm.stopTenant("loop-tenant", true);
    } catch {
      stopThrew = true;
    }
    check("stopTenant on a 'failed' tenant does not throw", !stopThrew);
    check("stopTenant on a 'failed' tenant leaves status as 'failed' (honest signal, not relabeled 'stopped')", fm.getTenantStatus("loop-tenant")?.status === "failed");

    // Manual intervention: an explicit spawnTenant() on a 'failed' tenant
    // is the documented way to give it a fresh attempt (see the runbook) —
    // it must reset consecutiveCrashes so the new attempt gets the full
    // backoff/give-up budget again, not an immediate re-give-up.
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_EXIT_CODE;
    const retried = await fm.spawnTenant("loop-tenant");
    check("spawnTenant on a 'failed' tenant is accepted (manual retry), not rejected", retried.clientId === "loop-tenant");
    await waitFor(() => fm.getTenantStatus("loop-tenant")?.status === "running");
    check("the manually-retried tenant reaches running", fm.getTenantStatus("loop-tenant")?.status === "running");
    check("consecutiveCrashes was reset to 0 by the manual retry", fm.getTenantStatus("loop-tenant")?.consecutiveCrashes === 0);

    await fm.stopTenant("loop-tenant", true);
  }

  // ── TASK 3: a sustained-healthy run resets consecutiveCrashes instead of
  // continuing to escalate the backoff from an unrelated later crash ─────
  {
    process.env.FAKE_CRASH_AFTER_MS = "20";
    process.env.FAKE_EXIT_CODE = "5";
    const tenantsRoot = freshTempRoot();
    const logsRoot = freshTempRoot();
    const fm = new FleetManager({
      engineInvocation: fakeInvocation(),
      tenantsRoot,
      logsRoot,
      restartBackoffMs: 100,
      sustainedHealthyMs: 150,
      maxConsecutiveCrashes: 5,
    });

    await fm.spawnTenant("reset-tenant");
    const firstCrash = await waitFor(() => fm.getTenantStatus("reset-tenant")?.status === "crashed", 2000);
    check("reset-tenant: first crash observed", firstCrash);
    check("reset-tenant: consecutiveCrashes is 1 after the first crash", fm.getTenantStatus("reset-tenant")?.consecutiveCrashes === 1);

    // Before the scheduled restart fires (backoff=100ms gives us a window),
    // reconfigure the fixture so the NEXT run survives well past
    // sustainedHealthyMs (150ms) instead of crashing again immediately.
    process.env.FAKE_CRASH_AFTER_MS = "400";
    const restarted = await waitFor(() => fm.getTenantStatus("reset-tenant")?.status === "running", 2000);
    check("reset-tenant: restarts after the first crash's backoff", restarted);

    // Stay running past sustainedHealthyMs before it crashes again (~400ms mark).
    await sleep(200);
    check("reset-tenant: still running past sustainedHealthyMs (proves this run counts as healthy)", fm.getTenantStatus("reset-tenant")?.status === "running");

    const secondCrash = await waitFor(() => fm.getTenantStatus("reset-tenant")?.status === "crashed", 2000);
    check("reset-tenant: second crash observed after the sustained-healthy run", secondCrash);
    check(
      "consecutiveCrashes reset to 1 (not 2) because the prior run was sustained-healthy",
      fm.getTenantStatus("reset-tenant")?.consecutiveCrashes === 1,
    );

    await fm.stopTenant("reset-tenant", false);
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_EXIT_CODE;
  }

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fleet-manager.test.ts crashed:", err);
  process.exit(1);
});
