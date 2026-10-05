/**
 * REAL-ENGINE 10-tenant capacity measurement (hosted PAPER release candidate).
 *
 * Starts N real packaged aria-engine tenants (`shadow start`, the only mode
 * that runs without the production entitlement key) under ONE shared
 * FleetManager, samples control-plane + per-tenant process-tree memory/CPU
 * every CAP_SAMPLE_MS, SIGKILLs one tenant mid-run to confirm recovery, then
 * stops everything and checks for orphans.
 *
 * Run:
 *   node scripts/package-engine.mjs --sha <engine sha> --dest <dir>
 *   ARIA_PACKAGED_ENGINE_PATH=<dir> CAP_OUT=<json path> npx tsx scripts/real-engine-capacity-run.mts
 *
 * Market data: shadow mode has no synthetic source (it always runs real
 * discovery). Each tenant's config.json is pre-seeded with rpc.url pointing to
 * scripts/stub-rpc.mjs on 127.0.0.1, which answers every call with an empty
 * result, so NO external RPC/Jupiter/Raydium endpoint is contacted. This
 * therefore measures supervision + idle discovery-polling footprint, NOT
 * processing of real launch candidates.
 *
 * WINDOWS-measured (PowerShell Get-CimInstance). Not paper mode with a price
 * feed, not Linux.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FleetManager, type EngineInvocation } from "../src/fleet/fleet-manager.js";
import { resolveEngineIdentity } from "../src/fleet/engine-identity.js";

const ENGINE_PATH = process.env.ARIA_PACKAGED_ENGINE_PATH!;
const OUT = process.env.CAP_OUT!;
if (!ENGINE_PATH || !OUT) throw new Error("set ARIA_PACKAGED_ENGINE_PATH and CAP_OUT");
const N = Number(process.env.CAP_N ?? 10);
const DURATION_MS = Number(process.env.CAP_DURATION_MS ?? 15 * 60_000);
const SAMPLE_MS = Number(process.env.CAP_SAMPLE_MS ?? 30_000);
const KILL_AT_MS = Number(process.env.CAP_KILL_AT_MS ?? 7 * 60_000);
const STUB_PORT = Number(process.env.CAP_STUB_PORT ?? 18899);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = readFileSync(path.join(ENGINE_PATH, ".engine-sha"), "utf8").trim();
const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface ProcRow { pid: number; ppid: number; wsKB: number; privKB: number; cpuSec: number; name: string }
function snapshotProcs(): ProcRow[] {
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|tsx|esbuild)' } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;wsKB=[math]::Round($_.WorkingSetSize/1KB);privKB=$_.PrivatePageCount/1KB;cpuSec=($_.KernelModeTime+$_.UserModeTime)/1e7;name=$_.Name} } | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  const j = JSON.parse(out || "[]");
  return (Array.isArray(j) ? j : [j]).map((r: any) => ({ pid: r.pid, ppid: r.ppid, wsKB: r.wsKB, privKB: Math.round(r.privKB), cpuSec: r.cpuSec, name: r.name }));
}
function tree(rows: ProcRow[], root: number): ProcRow[] {
  const out: ProcRow[] = [];
  const q = [root];
  while (q.length) {
    const p = q.pop()!;
    const r = rows.find((x) => x.pid === p);
    if (r) out.push(r);
    for (const c of rows) if (c.ppid === p) q.push(c.pid);
  }
  return out;
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "aria-cap-"));
const tenantsRoot = path.join(tmpRoot, "tenants");
const logsRoot = path.join(tmpRoot, "logs");

// Offline stub RPC (separate process, measured separately).
const stub = spawn(process.execPath, [path.join(import.meta.dirname, "stub-rpc.mjs"), String(STUB_PORT)], { stdio: "ignore" });
await sleep(1000);

// Seed each tenant's config.json using the packaged engine's own defaults.
const { defaultRuntimeConfig } = await import(pathToFileURL(path.join(ENGINE_PATH, "src", "runtime", "runtime-config.ts")).href);
const ids = Array.from({ length: N }, (_, i) => `cap-tenant-${i}`);
const inv: EngineInvocation = {
  buildStart: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "shadow", "start"], cwd: ENGINE_PATH }),
  buildStop: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "shadow", "stop"], cwd: ENGINE_PATH }),
  readyMarker: "shadow mode started",
};
const fm = new FleetManager({
  engineInvocation: inv,
  verifyEngineIdentity: () => resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: sha }),
  tenantsRoot,
  logsRoot,
  maxConcurrentTenants: 12,
  restartBackoffMs: 1000,
  sustainedHealthyMs: 500,
});
for (const id of ids) {
  const dir = fm.runtimeDirFor(id);
  mkdirSync(dir, { recursive: true });
  const cfg = defaultRuntimeConfig();
  cfg.rpc.url = `http://127.0.0.1:${STUB_PORT}`;
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}

const ev: any = {
  startedAtIso: new Date().toISOString(),
  platform: `${process.platform} ${os.release()} (Windows)`,
  mode: "shadow start (NOT paper mode)",
  marketSource: `offline stub JSON-RPC at 127.0.0.1:${STUB_PORT} (rpc.url pre-seeded); zero external endpoints`,
  engineSha: sha,
  controlPlaneSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  nodeVersion: process.version,
  cpus: os.cpus().length,
  params: { N, DURATION_MS, SAMPLE_MS, KILL_AT_MS, maxConcurrentTenants: 12 },
  startToRunningMs: {},
  samples: [],
  events: [],
};
const t0 = Date.now();
for (const id of ids) await fm.spawnTenant(id);
for (const id of ids) {
  const dl = Date.now() + 120_000;
  while (Date.now() < dl && fm.getTenantStatus(id)?.status !== "running") await sleep(250);
  ev.startToRunningMs[id] = fm.getTenantStatus(id)?.status === "running" ? Date.now() - t0 : null;
}
const everPids = new Set<number>();
let killed: { id: string; oldPid: number } | null = null;
const tStart = Date.now();
function sample() {
  const rows = snapshotProcs();
  const me = process.pid;
  const self = rows.find((r) => r.pid === me);
  const mu = process.memoryUsage();
  const stubRow = stub.pid ? rows.find((x) => x.pid === stub.pid) : undefined;
  const s: any = {
    atIso: new Date().toISOString(),
    elapsedMs: Date.now() - tStart,
    controlPlane: { pid: me, rssKB: Math.round(mu.rss / 1024), heapUsedKB: Math.round(mu.heapUsed / 1024), wsKB: self?.wsKB, privKB: self?.privKB },
    stub: stubRow ? { wsKB: stubRow.wsKB, privKB: stubRow.privKB } : null,
    tenants: {} as Record<string, any>,
    activeTenantCount: fm.listActiveTenants().length,
  };
  for (const id of ids) {
    const st = fm.getTenantStatus(id);
    const pid = st?.pid;
    if (pid) everPids.add(pid);
    const t = pid ? tree(rows, pid) : [];
    for (const r of t) everPids.add(r.pid);
    s.tenants[id] = {
      status: st?.status,
      pid,
      restartCount: st?.restartCount,
      procCount: t.length,
      wsKB: t.reduce((a, r) => a + r.wsKB, 0),
      privKB: t.reduce((a, r) => a + r.privKB, 0),
      cpuSec: Math.round(t.reduce((a, r) => a + r.cpuSec, 0) * 100) / 100,
      rootWsKB: t.find((r) => r.pid === pid)?.wsKB,
      rootPrivKB: t.find((r) => r.pid === pid)?.privKB,
    };
  }
  ev.samples.push(s);
  console.log(
    `[${(s.elapsedMs / 1000).toFixed(0)}s] active=${s.activeTenantCount} cp.rss=${s.controlPlane.rssKB}KB tenantWS(sum)=${Object.values(s.tenants).reduce((a: number, t: any) => a + (t.wsKB ?? 0), 0)}KB`,
  );
}
while (Date.now() - tStart < DURATION_MS) {
  sample();
  if (!killed && Date.now() - tStart >= KILL_AT_MS) {
    const id = ids[3];
    const pid = fm.getTenantStatus(id)!.pid!;
    killed = { id, oldPid: pid };
    process.kill(pid, "SIGKILL");
    ev.events.push({ atIso: new Date().toISOString(), elapsedMs: Date.now() - tStart, action: "SIGKILL", clientId: id, pid });
    console.log(`SIGKILL ${id} pid ${pid}`);
  }
  await sleep(SAMPLE_MS);
}
sample();
if (killed) {
  const st = fm.getTenantStatus(killed.id);
  ev.recovery = {
    clientId: killed.id,
    oldPid: killed.oldPid,
    oldPidGone: !alive(killed.oldPid),
    finalStatus: st?.status,
    newPid: st?.pid,
    restartCount: st?.restartCount,
    recovered: st?.status === "running" && st?.pid !== killed.oldPid,
  };
}
ev.statusAtEnd = Object.fromEntries(ids.map((id) => [id, fm.getTenantStatus(id)]));
try {
  ev.stubStats = await (await fetch(`http://127.0.0.1:${STUB_PORT}/stats`)).json();
} catch {
  /* ignore */
}
const before = [...everPids];
for (const id of ids) await fm.stopTenant(id, false);
await sleep(3000);
ev.shutdown = {
  everSeenPidsIncludingChildren: before.length,
  orphanedPids: before.filter(alive),
  activeAfter: fm.listActiveTenants().length,
};
stub.kill();
ev.finishedAtIso = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(ev, null, 2));
console.log(`evidence -> ${OUT}`);
rmSync(tmpRoot, { recursive: true, force: true });
process.exit(0);
