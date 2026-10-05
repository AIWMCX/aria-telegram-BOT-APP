#!/usr/bin/env node
/**
 * Fleet Manager soak test — Task 6 of
 * docs/superpowers/plans/2026-09-08-hosted-engine-plan.md.
 *
 * Spins up N synthetic tenants against the REAL `FleetManager`
 * (src/fleet/fleet-manager.ts), using the same fake-fixture pattern already
 * established in src/fleet/test-fixtures/fake-engine.mjs for a controlled,
 * non-real-RPC-calling engine stand-in (per the plan's own "synthetic
 * market mode, no real RPC calls" instruction) — this is Fleet-Manager-level
 * load, NOT a real aria-engine CLI/RPC soak (that is a separate, still-
 * outstanding program: reference-driven-commercialization's own Task 10).
 *
 * Two phases, run sequentially in one process invocation so the whole run
 * consumes real, continuous clock time as intended:
 *   Phase 1 (warmup):  N=5,  short duration, verify clean spawn/stop.
 *   Phase 2 (main soak): N=20 SPAWNED, long duration, deliberate fault
 *                        injection partway through (direct SIGKILL
 *                        bypassing FleetManager's own stop path, plus
 *                        2 of the 20 DESIGNED to crash-loop to terminal
 *                        `failed` early, so the SUSTAINED concurrent count
 *                        for the bulk of the run is 18, not 20 — see
 *                        docs/FLEET_MANAGER_RUNBOOK.md §9 for the real,
 *                        measured numbers; N alone is not a concurrency
 *                        claim). Tenants
 *                        configured to crash-loop until they hit the
 *                        documented give-up threshold).
 *
 * Evidence (real numbers, not estimated) is written to
 * scripts/fleet-soak-evidence.json and printed to stdout as it's gathered.
 * docs/FLEET_MANAGER_RUNBOOK.md is updated separately, by hand, from this
 * file's output — this script does not write the runbook itself.
 *
 * Run: npx tsx scripts/fleet-soak.ts
 * Env overrides (all optional, ms unless noted):
 *   SOAK_WARMUP_DURATION_MS   default 90000   (90s)
 *   SOAK_MAIN_DURATION_MS     default 1800000 (30 min)
 *   SOAK_MAIN_N               default 20
 *   SOAK_SAMPLE_INTERVAL_MS   default 60000   (60s)
 *   SOAK_FAULT_INJECT_AT_MS   default 480000  (8 min into phase 2)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FleetManager, FleetCapacityError, type EngineInvocation } from "../src/fleet/fleet-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(REPO_ROOT, "src", "fleet", "test-fixtures", "fake-engine.mjs");
/**
 * Single shared fixture for the main soak's crash-loop, SIGKILL-target, AND
 * control tenants alike (second re-certification fix, 2026-09-19) — derives
 * its per-tenant marker AND its crash-loop-or-not behavior entirely from
 * `ARIA_RUNTIME_DIR` (set by TenantProcess on every launch) and the
 * clientId's own naming convention, respectively. See its own docblock for
 * the full rationale for why this replaced the previous per-tenant-
 * FleetManager-instance design. Phase 1 (warmup) is unaffected and still
 * uses the plain `fakeInvocation()`/`FIXTURE` below — it never needed
 * per-tenant markers or crash-loop behavior.
 */
const MAIN_SOAK_FIXTURE = path.join(__dirname, "fleet-soak-fixture.mjs");

/** Must match every EngineInvocation's `readyMarker` below — kept as one constant so the ready-marker-count check (P0-1 re-certification) can never silently drift from what the fixtures actually print. */
const READY_MARKER = "paper engine started";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function freshTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeInvocation(): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: [FIXTURE, "start"], cwd: __dirname }),
    buildStop: () => ({ command: process.execPath, args: [FIXTURE, "stop"], cwd: __dirname }),
    readyMarker: READY_MARKER,
  };
}

/**
 * The distinctive per-tenant log marker, derived identically here (for the
 * post-run journal check) and inside fleet-soak-fixture.mjs itself (for what
 * actually gets printed) — both derive it from the tenant's clientId, which
 * fleet-soak-fixture.mjs reads back out of its own `ARIA_RUNTIME_DIR`.
 *
 * REAL BUG found and fixed during the first re-certification cycle's own
 * dry-run/full-run discipline (disclosed, not silently patched): an earlier
 * version of this function returned `SOAK-MARKER::${clientId}` with no
 * closing delimiter, which is unbounded on the right — e.g.
 * `SOAK-MARKER::soak-control-1` is a literal PREFIX of
 * `SOAK-MARKER::soak-control-10` through `...-19`. At N=20 (but not at the
 * smaller N used in earlier dry-runs, which never reached two-digit tenant
 * indices), the contamination check's `content.includes(otherMarker)`
 * matched a short id's marker as a substring of every longer id sharing that
 * prefix's OWN correctly-printed marker line, producing false-positive
 * "contamination" findings in an otherwise-clean run. The trailing `::END`
 * closes the token on both sides (already delimited by `::` on the left), so
 * no tenant's full marker string can ever be a substring of another
 * tenant's.
 */
function markerFor(clientId: string): string {
  return `SOAK-MARKER::${clientId}::END`;
}

/**
 * ONE shared invocation for every main-soak tenant (crash-loop, SIGKILL-
 * target, and control alike) — second re-certification fix, 2026-09-19,
 * replacing the per-tenant-closure/per-tenant-FleetManager-instance design a
 * second independent review found both unnecessary and actively harmful (see
 * fleet-soak-fixture.mjs's own docblock for the full finding). `buildStart`/
 * `buildStop` take no `clientId` parameter — and don't need one anymore: the
 * fixture itself derives its clientId from `ARIA_RUNTIME_DIR` (which
 * `TenantProcess` sets on every launch, initial or restart, regardless of
 * how many `FleetManager` instances exist) and decides its own marker AND
 * its own crash-loop-or-not behavior from that, purely by naming convention
 * (`soak-crashloop-*`). This lets ALL main-soak tenants share ONE
 * `FleetManager` instance and therefore ONE shared in-memory bookkeeping
 * `Map` — restoring the isolation channel a real cross-tenant bug would
 * actually have to corrupt to go undetected.
 */
function mainSoakInvocation(): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: [MAIN_SOAK_FIXTURE, "start"], cwd: __dirname }),
    buildStop: () => ({ command: process.execPath, args: [MAIN_SOAK_FIXTURE, "stop"], cwd: __dirname }),
    readyMarker: READY_MARKER,
  };
}

/** Windows-only: real OS-level RSS (KB) for a pid via `tasklist`, or null if the process is gone. */
function windowsRssKb(pid: number): number | null {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!out || out.toLowerCase().includes("no tasks")) return null;
    // CSV: "image.exe","1234","Console","1","12,345 K"
    const fields = out.split('","').map((f) => f.replace(/^"|"$/g, ""));
    const memField = fields[4]; // "12,345 K"
    if (!memField) return null;
    const digits = memField.replace(/[^0-9]/g, "");
    return digits ? Number(digits) : null;
  } catch {
    return null;
  }
}

/** OS-level liveness check — proves the real process exists, not just FleetManager's in-memory bookkeeping. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface MemSample {
  atIso: string;
  elapsedMs: number;
  fleetManagerProcessRssKb: number; // this script's own process (hosts the real FleetManager instance)
  fleetManagerProcessHeapUsedKb: number;
  sampledTenantRssKb: Record<string, number | null>;
  activeTenantCount: number;
}

interface FaultEvent {
  atIso: string;
  elapsedMs: number;
  clientId: string;
  action: "SIGKILL" | "crash-loop-configured";
  pidAtInjection?: number;
}

interface StatusSnapshot {
  atIso: string;
  elapsedMs: number;
  tenants: Array<{
    clientId: string;
    status: string;
    pid?: number;
    consecutiveCrashes: number;
    restartCount: number;
    lastExitCode?: number | null;
  }>;
}

const evidence: {
  startedAtIso: string;
  ariaTelegramBotAppShaAtStart: string;
  ariaEngineBranchAtStart: string;
  ariaEngineShaAtStart: string;
  phase1Warmup: Record<string, unknown>;
  phase2MainSoak: Record<string, unknown>;
  memSamples: MemSample[];
  faultEvents: FaultEvent[];
  statusSnapshots: StatusSnapshot[];
  finishedAtIso?: string;
  totalElapsedMs?: number;
} = {
  startedAtIso: nowIso(),
  ariaTelegramBotAppShaAtStart: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  ariaEngineBranchAtStart: "unknown",
  ariaEngineShaAtStart: "unknown",
  phase1Warmup: {},
  phase2MainSoak: {},
  memSamples: [],
  faultEvents: [],
  statusSnapshots: [],
};

try {
  const engineRepo = path.resolve(REPO_ROOT, "..", "aria-engine");
  evidence.ariaEngineBranchAtStart = execFileSync("git", ["branch", "--show-current"], { cwd: engineRepo, encoding: "utf8" }).trim();
  evidence.ariaEngineShaAtStart = execFileSync("git", ["rev-parse", "HEAD"], { cwd: engineRepo, encoding: "utf8" }).trim();
} catch {
  // sibling repo path not resolvable from this environment — recorded as "unknown" honestly, not guessed.
}

/** A lookup across possibly-multiple FleetManager instances (this soak uses two — see runPhase2MainSoak). */
type StatusLookup = (clientId: string) => ReturnType<FleetManager["getTenantStatus"]>;

function takeMemSample(lookup: StatusLookup, activeCount: () => number, sampleTenantIds: string[], elapsedMs: number): MemSample {
  const mu = process.memoryUsage();
  const sampledTenantRssKb: Record<string, number | null> = {};
  for (const id of sampleTenantIds) {
    const handle = lookup(id);
    sampledTenantRssKb[id] = handle?.pid ? windowsRssKb(handle.pid) : null;
  }
  const sample: MemSample = {
    atIso: nowIso(),
    elapsedMs,
    fleetManagerProcessRssKb: Math.round(mu.rss / 1024),
    fleetManagerProcessHeapUsedKb: Math.round(mu.heapUsed / 1024),
    sampledTenantRssKb,
    activeTenantCount: activeCount(),
  };
  evidence.memSamples.push(sample);
  console.log(
    `[mem @${(elapsedMs / 1000).toFixed(0)}s] FleetManager-process RSS=${sample.fleetManagerProcessRssKb}KB heapUsed=${sample.fleetManagerProcessHeapUsedKb}KB active=${sample.activeTenantCount} tenants=${JSON.stringify(sampledTenantRssKb)}`,
  );
  return sample;
}

function takeStatusSnapshot(lookup: StatusLookup, ids: string[], elapsedMs: number): StatusSnapshot {
  const snap: StatusSnapshot = {
    atIso: nowIso(),
    elapsedMs,
    tenants: ids.map((id) => {
      const h = lookup(id);
      return {
        clientId: id,
        status: h?.status ?? "untracked",
        pid: h?.pid,
        consecutiveCrashes: h?.consecutiveCrashes ?? 0,
        restartCount: h?.restartCount ?? 0,
        lastExitCode: h?.lastExitCode,
      };
    }),
  };
  evidence.statusSnapshots.push(snap);
  return snap;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function runPhase1Warmup(): Promise<void> {
  console.log("\n=== PHASE 1: WARMUP (N=5) ===");
  const durationMs = Number(process.env.SOAK_WARMUP_DURATION_MS ?? 90_000);
  const tenantsRoot = freshTempRoot("fleet-soak-warmup-tenants-");
  const logsRoot = freshTempRoot("fleet-soak-warmup-logs-");
  const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, maxConcurrentTenants: 5 });

  const ids = Array.from({ length: 5 }, (_, i) => `soak-warmup-${i}`);
  const t0 = Date.now();

  for (const id of ids) {
    delete process.env.FAKE_CRASH_AFTER_MS;
    delete process.env.FAKE_EXIT_CODE;
    delete process.env.FAKE_FAIL_ON_START;
    await fm.spawnTenant(id);
  }

  const allRunning = await waitFor(() => ids.every((id) => fm.getTenantStatus(id)?.status === "running"), 10_000);
  console.log(`warmup: all 5 tenants reached running = ${allRunning}`);

  const pids = ids.map((id) => fm.getTenantStatus(id)?.pid).filter((p): p is number => typeof p === "number");
  console.log(`warmup: pids = ${pids.join(", ")}`);

  const remaining = durationMs - (Date.now() - t0);
  if (remaining > 0) {
    console.log(`warmup: holding steady for ${Math.round(remaining / 1000)}s...`);
    await sleep(remaining);
  }

  const stillRunning = ids.every((id) => fm.getTenantStatus(id)?.status === "running");
  const allPidsStillAlivePreStop = pids.every(isPidAlive);
  console.log(`warmup: all still running after hold = ${stillRunning}, all pids still OS-alive = ${allPidsStillAlivePreStop}`);

  for (const id of ids) {
    await fm.stopTenant(id, true);
  }
  const allStopped = ids.every((id) => fm.getTenantStatus(id)?.status === "stopped");
  const orphans = pids.filter(isPidAlive);

  evidence.phase1Warmup = {
    durationMs,
    tenantCount: ids.length,
    allReachedRunning: allRunning,
    allStillRunningAfterHold: stillRunning,
    pids,
    allStoppedCleanly: allStopped,
    orphanedPidsAfterStop: orphans,
  };

  console.log(`warmup: all stopped cleanly = ${allStopped}, orphaned pids after stop = [${orphans.join(", ")}]`);
  if (orphans.length > 0) {
    console.log("warmup: WARNING — orphaned processes detected, this alone is a RED-verdict finding.");
  }

  fs.rmSync(tenantsRoot, { recursive: true, force: true });
  fs.rmSync(logsRoot, { recursive: true, force: true });
}

async function runPhase2MainSoak(): Promise<void> {
  console.log("\n=== PHASE 2: MAIN SOAK ===");
  const N = Number(process.env.SOAK_MAIN_N ?? 20);
  const durationMs = Number(process.env.SOAK_MAIN_DURATION_MS ?? 30 * 60_000);
  const sampleIntervalMs = Number(process.env.SOAK_SAMPLE_INTERVAL_MS ?? 60_000);
  const faultInjectAtMs = Number(process.env.SOAK_FAULT_INJECT_AT_MS ?? 8 * 60_000);

  const tenantsRoot = freshTempRoot("fleet-soak-main-tenants-");
  const logsRoot = freshTempRoot("fleet-soak-main-logs-");

  const CRASH_LOOP_COUNT = 2;
  const SIGKILL_COUNT = 3;
  // Naming convention carries the per-tenant behavior now (read by
  // fleet-soak-fixture.mjs itself, purely from its own ARIA_RUNTIME_DIR) --
  // "soak-crashloop-*" ids are what trigger FAKE_CRASH_AFTER_MS inside the
  // fixture. See mainSoakInvocation()'s and fleet-soak-fixture.mjs's
  // docblocks.
  const crashLoopIds = Array.from({ length: CRASH_LOOP_COUNT }, (_, i) => `soak-crashloop-${i}`);
  const sigkillIds = Array.from({ length: SIGKILL_COUNT }, (_, i) => `soak-sigkill-${i}`);
  const controlIds = Array.from({ length: N - CRASH_LOOP_COUNT - SIGKILL_COUNT }, (_, i) => `soak-control-${i}`);
  const allIds = [...crashLoopIds, ...sigkillIds, ...controlIds];

  console.log(`main soak: N=${N} spawned (crash-loop=${crashLoopIds.length}, sigkill-target=${sigkillIds.length}, control=${controlIds.length}) -- the 2 crash-loop tenants are BY DESIGN expected to reach terminal 'failed' early, so the sustained concurrent count for the bulk of the run is N-2, not N (see the "sustained" fields recorded in evidence below -- do not read N alone as a concurrency claim).`);

  // ONE shared FleetManager instance for the ENTIRE main soak (second
  // re-certification fix, 2026-09-19 -- restores the ORIGINAL, first-
  // reviewed topology from commit 54ca099: all main-soak tenants under one
  // instance with a real maxConcurrentTenants cap). The prior fix
  // (commit 1123008) split this into 20 separate per-tenant instances
  // (each maxConcurrentTenants:1) solely so each tenant could get its own
  // marker-baking EngineInvocation closure that survived restarts -- a
  // second independent review found this both unnecessary (the fixture can
  // derive its own restart-stable marker from ARIA_RUNTIME_DIR, which
  // TenantProcess sets on every launch regardless of instance topology --
  // see fleet-soak-fixture.mjs) and actively harmful: with 20 separate
  // instances, no two tenants share FleetManager's private per-instance
  // bookkeeping Map, so a REAL cross-tenant isolation bug inside
  // FleetManager itself would produce zero signal in that topology -- only
  // an externally-injected OS-level kill was still detectable. Restoring
  // one shared instance means the in-memory isolation channel is actually
  // exercised again: a control tenant and a crash-looping/sigkilled tenant
  // now genuinely share the same Map a real bug could corrupt.
  const fm = new FleetManager({ engineInvocation: mainSoakInvocation(), tenantsRoot, logsRoot, maxConcurrentTenants: N });

  const lookup: StatusLookup = (id) => fm.getTenantStatus(id);
  const activeCount = () => fm.listActiveTenants().length;

  const t0 = Date.now();

  delete process.env.FAKE_CRASH_AFTER_MS;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_FAIL_ON_START;
  delete process.env.FAKE_EXTRA_LINE;
  for (const id of crashLoopIds) {
    await fm.spawnTenant(id);
    evidence.faultEvents.push({ atIso: nowIso(), elapsedMs: Date.now() - t0, clientId: id, action: "crash-loop-configured" });
  }
  const nonCrashLoop = [...sigkillIds, ...controlIds];
  for (const id of nonCrashLoop) {
    await fm.spawnTenant(id);
  }

  const allNonCrashLoopRunning = await waitFor(
    () => nonCrashLoop.every((id) => lookup(id)?.status === "running"),
    15_000,
  );
  console.log(`main soak: all ${nonCrashLoop.length} non-crash-loop tenants reached running = ${allNonCrashLoopRunning}`);

  takeMemSample(lookup, activeCount, allIds, 0);
  takeStatusSnapshot(lookup, allIds, 0);

  let faultInjected = false;
  let preInjectionSnapshot: StatusSnapshot | null = null;
  const killedPids: Record<string, number> = {};
  // P0-2 re-certification: real OS-level log-file stat for each control
  // tenant, captured at the moment fault injection begins, so the
  // post-run check can prove nothing touched a control tenant's log
  // during the fault-injection window -- not just that FleetManager's own
  // in-memory bookkeeping looks unchanged.
  const controlLogStatAtInjection: Record<string, { size: number; mtimeMs: number } | null> = {};

  while (Date.now() - t0 < durationMs) {
    await sleep(Math.min(sampleIntervalMs, Math.max(0, durationMs - (Date.now() - t0))));
    const elapsed = Date.now() - t0;
    takeMemSample(lookup, activeCount, allIds, elapsed);
    takeStatusSnapshot(lookup, allIds, elapsed);

    if (!faultInjected && elapsed >= faultInjectAtMs) {
      faultInjected = true;
      preInjectionSnapshot = takeStatusSnapshot(lookup, controlIds, elapsed);
      for (const id of controlIds) {
        try {
          const st = fs.statSync(path.join(logsRoot, `${id}.log`));
          controlLogStatAtInjection[id] = { size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          controlLogStatAtInjection[id] = null;
        }
      }
      console.log(`\n--- FAULT INJECTION @${Math.round(elapsed / 1000)}s: SIGKILL ${sigkillIds.length} tenants directly (bypassing stopTenant) ---`);
      for (const id of sigkillIds) {
        const handle = lookup(id);
        if (handle?.pid) {
          killedPids[id] = handle.pid;
          try {
            process.kill(handle.pid, "SIGKILL");
            console.log(`  SIGKILL sent to ${id} (pid ${handle.pid})`);
          } catch (err) {
            console.log(`  SIGKILL failed for ${id} (pid ${handle.pid}): ${(err as Error).message}`);
          }
          evidence.faultEvents.push({ atIso: nowIso(), elapsedMs: elapsed, clientId: id, action: "SIGKILL", pidAtInjection: handle.pid });
        }
      }
    }
  }

  const totalElapsed = Date.now() - t0;
  takeMemSample(lookup, activeCount, allIds, totalElapsed);
  const finalSnapshot = takeStatusSnapshot(lookup, allIds, totalElapsed);

  // Isolation check (in-memory half): control tenants must be COMPLETELY
  // unaffected by the sigkill'd/crash-loop tenants throughout -- same pid,
  // same restartCount, still running.
  const controlUnaffectedInMemory = controlIds.every((id) => {
    const pre = preInjectionSnapshot?.tenants.find((t) => t.clientId === id);
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return pre && post && post.status === "running" && post.pid === pre.pid && post.restartCount === pre.restartCount && post.consecutiveCrashes === 0;
  });

  // Isolation check (OS-level half -- P0-2 re-certification fix): the
  // in-memory check above only proves FleetManager's own bookkeeping is
  // consistent, which would also pass if the isolation logic itself were
  // silently broken but happened to report identical numbers. Reuse
  // isPidAlive() (already used for the shutdown-orphan check below) to
  // confirm the ACTUAL OS process the control tenant had before injection
  // is STILL the one running (not a coincidentally-same-status new
  // process), and stat() each control tenant's log file to confirm no
  // byte was written to it during the fault-injection window (size/mtime
  // unchanged from the sample taken the instant injection began).
  const controlOsLevelChecks = controlIds.map((id) => {
    const pre = preInjectionSnapshot?.tenants.find((t) => t.clientId === id);
    const prePid = pre?.pid;
    const pidStillAliveSamePid = typeof prePid === "number" ? isPidAlive(prePid) : false;
    const preStat = controlLogStatAtInjection[id] ?? null;
    let postStat: { size: number; mtimeMs: number } | null = null;
    try {
      const st = fs.statSync(path.join(logsRoot, `${id}.log`));
      postStat = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      postStat = null;
    }
    const logUnchangedSinceInjection = !!preStat && !!postStat && preStat.size === postStat.size && preStat.mtimeMs === postStat.mtimeMs;
    return { clientId: id, prePid, pidStillAliveSamePid, preStat, postStat, logUnchangedSinceInjection };
  });
  const controlOsLevelAllPass = controlOsLevelChecks.every((c) => c.pidStillAliveSamePid && c.logUnchangedSinceInjection);
  const controlUnaffected = controlUnaffectedInMemory && controlOsLevelAllPass;

  const sigkilledRecovered = sigkillIds.every((id) => {
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return post && post.status === "running" && post.pid !== killedPids[id] && post.restartCount >= 1;
  });

  const crashLoopersFailed = crashLoopIds.every((id) => {
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return post && post.status === "failed" && post.consecutiveCrashes >= 5;
  });

  console.log(`\nmain soak: control tenants (${controlIds.length}) completely unaffected (in-memory AND OS-level pid/log-file checks) = ${controlUnaffected} (in-memory=${controlUnaffectedInMemory}, OS-level=${controlOsLevelAllPass})`);
  console.log(`main soak: sigkilled tenants (${sigkillIds.length}) auto-recovered with NEW pids = ${sigkilledRecovered}`);
  console.log(`main soak: crash-loop tenants (${crashLoopIds.length}) correctly escalated to terminal 'failed' = ${crashLoopersFailed}`);

  // Journal integrity (P0-1 first re-certification fix, marker-derivation
  // mechanism replaced in the second re-certification fix): read every
  // tenant's log file and confirm (a) it's readable UTF-8 with no null
  // bytes, (b) it contains its OWN distinctive marker (markerFor(id) here;
  // fleet-soak-fixture.mjs derives the identical string from its own
  // ARIA_RUNTIME_DIR at runtime -- see that file's docblock for why this
  // survives every restart, initial or auto-restart, with zero need for a
  // per-tenant closure or FleetManager instance), (c) it does
  // NOT contain any OTHER tenant's marker (real cross-contamination check --
  // the previous version of this check compared against sibling clientId
  // strings that were never actually written to any log, so it could never
  // fire), and (d) the ready-marker count matches that tenant's expected
  // lifecycle (control=1 start, sigkill-target=2 starts [initial + the one
  // post-SIGKILL auto-restart], crash-loop=5 starts [initial + 4 restarts
  // before the 5th crash hits maxConsecutiveCrashes=5 and gives up]) -- this
  // catches restart-path bugs (e.g. a tenant restarting more or fewer times
  // than the state machine should allow) that a pure string-presence check
  // would miss entirely.
  const expectedReadyMarkerCount: Record<string, number> = {};
  for (const id of crashLoopIds) expectedReadyMarkerCount[id] = 5;
  for (const id of sigkillIds) expectedReadyMarkerCount[id] = 2;
  for (const id of controlIds) expectedReadyMarkerCount[id] = 1;

  const readyMarkerCounts: Record<string, number> = {};
  let journalIssues: string[] = [];
  for (const id of allIds) {
    const logPath = path.join(logsRoot, `${id}.log`);
    if (!fs.existsSync(logPath)) {
      journalIssues.push(`${id}: log file missing`);
      continue;
    }
    const content = fs.readFileSync(logPath, "utf8");
    if (content.includes("\0")) journalIssues.push(`${id}: contains null byte(s)`);

    const ownMarker = markerFor(id);
    if (!content.includes(ownMarker)) {
      journalIssues.push(`${id}: log is MISSING its own marker '${ownMarker}'`);
    }
    for (const other of allIds) {
      if (other === id) continue;
      const otherMarker = markerFor(other);
      if (content.includes(otherMarker)) {
        journalIssues.push(`${id}: log contains sibling tenant ${other}'s marker '${otherMarker}' (real cross-contamination)`);
      }
    }

    const actualReadyCount = content.split(READY_MARKER).length - 1;
    readyMarkerCounts[id] = actualReadyCount;
    const expected = expectedReadyMarkerCount[id];
    if (actualReadyCount !== expected) {
      journalIssues.push(`${id}: ready-marker count ${actualReadyCount} != expected ${expected} for its lifecycle (restart-path mismatch)`);
    }
  }
  console.log(`main soak: journal integrity issues found = ${journalIssues.length}${journalIssues.length ? ": " + journalIssues.join("; ") : ""}`);
  console.log(`main soak: ready-marker counts = ${JSON.stringify(readyMarkerCounts)}`);

  // Clean shutdown: stop everything, verify zero orphaned OS processes.
  console.log("\nmain soak: stopping all tenants...");
  const allPidsBeforeShutdown = allIds
    .map((id) => lookup(id)?.pid)
    .filter((p): p is number => typeof p === "number");
  for (const id of nonCrashLoop) {
    await fm.stopTenant(id, true);
  }
  for (const id of crashLoopIds) {
    // A "failed" crash-loop tenant is a safe no-op for stopTenant (already
    // terminal, no process/timer to cancel) -- calling it anyway for symmetry
    // and to cover the case where a crash-loop tenant happens to be mid-run
    // (not yet failed) when the soak's duration elapses.
    await fm.stopTenant(id, true);
  }
  const orphans = allPidsBeforeShutdown.filter(isPidAlive);
  console.log(`main soak: orphaned pids after full shutdown = [${orphans.join(", ")}]`);

  // P1-3 re-certification fix: derive the ACTUAL sustained concurrent
  // tenant count from the real memSamples timeline instead of asserting
  // N throughout. The 2 crash-loop tenants are DESIGNED to reach terminal
  // `failed` early, so activeTenantCount legitimately drops from N to
  // N-2 shortly after t=0 and stays there for the rest of the run -- that
  // drop is correct behavior, not a defect, and must be described as such
  // rather than overstated as "N concurrent for the full duration".
  const countsAfterT0 = evidence.memSamples.filter((s) => s.elapsedMs > 0).map((s) => s.activeTenantCount);
  const sustainedTenantCount = countsAfterT0.length ? Math.min(...countsAfterT0) : N;
  const stabilizedAtSample = evidence.memSamples.find((s) => s.elapsedMs > 0 && s.activeTenantCount === sustainedTenantCount);
  const sustainedFromElapsedMs = stabilizedAtSample?.elapsedMs ?? 0;
  const sustainedDurationMs = Math.max(0, totalElapsed - sustainedFromElapsedMs);
  console.log(
    `main soak: ${N} tenants spawned; ${sustainedTenantCount} sustained concurrently from t=${Math.round(sustainedFromElapsedMs / 1000)}s ` +
      `to t=${Math.round(totalElapsed / 1000)}s (~${Math.round(sustainedDurationMs / 60000)} min) after the ${crashLoopIds.length} crash-loop tenants reached terminal 'failed' by design`,
  );

  evidence.phase2MainSoak = {
    N,
    durationMs,
    crashLoopIds,
    sigkillIds,
    controlIds,
    allNonCrashLoopReachedRunning: allNonCrashLoopRunning,
    controlTenantsCompletelyUnaffected: controlUnaffected,
    controlTenantsCompletelyUnaffectedInMemory: controlUnaffectedInMemory,
    controlTenantsOsLevelChecks: controlOsLevelChecks,
    sigkilledTenantsAutoRecovered: sigkilledRecovered,
    crashLoopTenantsEscalatedToFailed: crashLoopersFailed,
    journalIntegrityIssues: journalIssues,
    readyMarkerCounts,
    expectedReadyMarkerCounts: expectedReadyMarkerCount,
    orphanedPidsAfterShutdown: orphans,
    initialTenantCount: N,
    sustainedTenantCount,
    sustainedFromElapsedMs,
    sustainedDurationMs,
    totalElapsedMs: totalElapsed,
  };

  fs.rmSync(tenantsRoot, { recursive: true, force: true });
  fs.rmSync(logsRoot, { recursive: true, force: true });
}

async function main() {
  console.log(`Fleet Manager soak — started ${evidence.startedAtIso}`);
  console.log(`aria-telegram-BOT-APP SHA: ${evidence.ariaTelegramBotAppShaAtStart}`);
  console.log(`aria-engine branch/SHA: ${evidence.ariaEngineBranchAtStart} @ ${evidence.ariaEngineShaAtStart}`);

  const overallStart = Date.now();
  await runPhase1Warmup();
  await runPhase2MainSoak();

  evidence.finishedAtIso = nowIso();
  evidence.totalElapsedMs = Date.now() - overallStart;

  const outPath = path.join(__dirname, "fleet-soak-evidence.json");
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence written to ${outPath}`);
  console.log(`Total soak elapsed: ${Math.round((evidence.totalElapsedMs ?? 0) / 60000)} min ${Math.round(((evidence.totalElapsedMs ?? 0) / 1000) % 60)}s`);
}

main().catch((err) => {
  console.error("SOAK SCRIPT FAILED:", err);
  process.exitCode = 1;
});
