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
 *   Phase 2 (main soak): N=20, long duration, deliberate fault injection
 *                        partway through (direct SIGKILL bypassing
 *                        FleetManager's own stop path, plus tenants
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
const CRASHLOOP_FIXTURE = path.join(__dirname, "fleet-soak-crashloop-fixture.mjs");

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
    readyMarker: "paper engine started",
  };
}

/**
 * Invocation for the "crash-loop" tenants: uses fleet-soak-crashloop-fixture.mjs,
 * which bakes FAKE_CRASH_AFTER_MS into every fresh process's OWN environment
 * (see that file's docblock for why: a plain shared-process.env approach does
 * not survive to FleetManager's internal auto-restart, which fires long after
 * this script's own spawn loop has moved on and cleared the var).
 */
function crashLoopInvocation(): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: [CRASHLOOP_FIXTURE, "start"], cwd: __dirname }),
    buildStop: () => ({ command: process.execPath, args: [CRASHLOOP_FIXTURE, "stop"], cwd: __dirname }),
    readyMarker: "paper engine started",
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
  const allIds = Array.from({ length: N }, (_, i) => `soak-main-${i}`);
  const crashLoopIds = allIds.slice(0, CRASH_LOOP_COUNT);
  const sigkillIds = allIds.slice(CRASH_LOOP_COUNT, CRASH_LOOP_COUNT + SIGKILL_COUNT);
  const controlIds = allIds.slice(CRASH_LOOP_COUNT + SIGKILL_COUNT);

  console.log(`main soak: N=${N} (crash-loop=${crashLoopIds.length}, sigkill-target=${sigkillIds.length}, control=${controlIds.length})`);

  // TWO FleetManager instances, sharing the same tenantsRoot/logsRoot (each
  // tenant still gets its own <tenantsRoot>/<clientId>/.aria and
  // <logsRoot>/<clientId>.log — the split is purely about which
  // EngineInvocation spawns a given clientId, not about isolation, which is
  // per-clientId regardless of which manager instance issued the spawn).
  // The crash-loop tenants use fmCrashLoop (crashLoopInvocation, which bakes
  // FAKE_CRASH_AFTER_MS into every fresh child's OWN env via
  // fleet-soak-crashloop-fixture.mjs — see that file's docblock for the real
  // bug this replaced: a shared, soak-script-cleared process.env var did NOT
  // survive to FleetManager's internal auto-restart, so a first soak attempt
  // saw the crash-loop tenants crash exactly once and then look "recovered"
  // instead of correctly escalating). Everything else uses fm (plain
  // fakeInvocation, never crashes on its own).
  const fm = new FleetManager({ engineInvocation: fakeInvocation(), tenantsRoot, logsRoot, maxConcurrentTenants: N });
  const fmCrashLoop = new FleetManager({ engineInvocation: crashLoopInvocation(), tenantsRoot, logsRoot, maxConcurrentTenants: CRASH_LOOP_COUNT });

  const lookup: StatusLookup = (id) => fm.getTenantStatus(id) ?? fmCrashLoop.getTenantStatus(id);
  const activeCount = () => fm.listActiveTenants().length + fmCrashLoop.listActiveTenants().length;

  const t0 = Date.now();

  delete process.env.FAKE_CRASH_AFTER_MS;
  delete process.env.FAKE_EXIT_CODE;
  delete process.env.FAKE_FAIL_ON_START;
  for (const id of crashLoopIds) {
    await fmCrashLoop.spawnTenant(id);
    evidence.faultEvents.push({ atIso: nowIso(), elapsedMs: Date.now() - t0, clientId: id, action: "crash-loop-configured" });
  }
  const nonCrashLoop = [...sigkillIds, ...controlIds];
  for (const id of nonCrashLoop) {
    await fm.spawnTenant(id);
  }

  const allNonCrashLoopRunning = await waitFor(
    () => nonCrashLoop.every((id) => fm.getTenantStatus(id)?.status === "running"),
    15_000,
  );
  console.log(`main soak: all ${nonCrashLoop.length} non-crash-loop tenants reached running = ${allNonCrashLoopRunning}`);

  takeMemSample(lookup, activeCount, allIds, 0);
  takeStatusSnapshot(lookup, allIds, 0);

  let faultInjected = false;
  let preInjectionSnapshot: StatusSnapshot | null = null;
  const killedPids: Record<string, number> = {};

  while (Date.now() - t0 < durationMs) {
    await sleep(Math.min(sampleIntervalMs, Math.max(0, durationMs - (Date.now() - t0))));
    const elapsed = Date.now() - t0;
    takeMemSample(lookup, activeCount, allIds, elapsed);
    takeStatusSnapshot(lookup, allIds, elapsed);

    if (!faultInjected && elapsed >= faultInjectAtMs) {
      faultInjected = true;
      preInjectionSnapshot = takeStatusSnapshot(lookup, controlIds, elapsed);
      console.log(`\n--- FAULT INJECTION @${Math.round(elapsed / 1000)}s: SIGKILL ${sigkillIds.length} tenants directly (bypassing stopTenant) ---`);
      for (const id of sigkillIds) {
        const handle = fm.getTenantStatus(id);
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

  // Isolation check: control tenants must be COMPLETELY unaffected by the
  // sigkill'd tenants throughout — same pid, same restartCount, still running.
  const controlUnaffected = controlIds.every((id) => {
    const pre = preInjectionSnapshot?.tenants.find((t) => t.clientId === id);
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return pre && post && post.status === "running" && post.pid === pre.pid && post.restartCount === pre.restartCount && post.consecutiveCrashes === 0;
  });

  const sigkilledRecovered = sigkillIds.every((id) => {
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return post && post.status === "running" && post.pid !== killedPids[id] && post.restartCount >= 1;
  });

  const crashLoopersFailed = crashLoopIds.every((id) => {
    const post = finalSnapshot.tenants.find((t) => t.clientId === id);
    return post && post.status === "failed" && post.consecutiveCrashes >= 5;
  });

  console.log(`\nmain soak: control tenants (${controlIds.length}) completely unaffected = ${controlUnaffected}`);
  console.log(`main soak: sigkilled tenants (${sigkillIds.length}) auto-recovered with NEW pids = ${sigkilledRecovered}`);
  console.log(`main soak: crash-loop tenants (${crashLoopIds.length}) correctly escalated to terminal 'failed' = ${crashLoopersFailed}`);

  // Journal integrity: read every tenant's log file, confirm well-formed
  // (readable UTF-8, contains the ready marker at least once for any tenant
  // that ever reached running, no null bytes / no cross-tenant contamination
  // of another tenant's clientId string).
  let journalIssues: string[] = [];
  for (const id of allIds) {
    const logPath = path.join(logsRoot, `${id}.log`);
    if (!fs.existsSync(logPath)) {
      journalIssues.push(`${id}: log file missing`);
      continue;
    }
    const content = fs.readFileSync(logPath, "utf8");
    if (content.includes(" ")) journalIssues.push(`${id}: contains null byte(s)`);
    const otherIds = allIds.filter((o) => o !== id);
    for (const other of otherIds) {
      if (content.includes(other)) journalIssues.push(`${id}: log contains sibling tenant id '${other}' (cross-contamination)`);
    }
  }
  console.log(`main soak: journal integrity issues found = ${journalIssues.length}${journalIssues.length ? ": " + journalIssues.join("; ") : ""}`);

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
    // terminal, no process/timer to cancel) — calling it anyway for symmetry
    // and to cover the case where a crash-loop tenant happens to be mid-run
    // (not yet failed) when the soak's duration elapses.
    await fmCrashLoop.stopTenant(id, true);
  }
  const orphans = allPidsBeforeShutdown.filter(isPidAlive);
  console.log(`main soak: orphaned pids after full shutdown = [${orphans.join(", ")}]`);

  evidence.phase2MainSoak = {
    N,
    durationMs,
    crashLoopIds,
    sigkillIds,
    controlIds,
    allNonCrashLoopReachedRunning: allNonCrashLoopRunning,
    controlTenantsCompletelyUnaffected: controlUnaffected,
    sigkilledTenantsAutoRecovered: sigkilledRecovered,
    crashLoopTenantsEscalatedToFailed: crashLoopersFailed,
    journalIntegrityIssues: journalIssues,
    orphanedPidsAfterShutdown: orphans,
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
