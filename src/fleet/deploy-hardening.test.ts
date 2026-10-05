/**
 * Deploy-hardening tests: FLEET_* config validation, kill switch + founder-only
 * allow-list (commands, rehydration, approval re-check), /fleet_stop_all core,
 * default cap 3, memory guard, tenant log rotation, package-engine credential
 * scrubbing.
 *
 * Run: npx tsx src/fleet/deploy-hardening.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FleetManager, FleetCapacityError, FleetLowMemoryError, type EngineInvocation } from "./fleet-manager.js";
import { parseFleetFlags, FleetConfigError } from "./fleet-config.js";
import { createFleetAccess } from "./fleet-access.js";
import { readAvailableMemoryBytes } from "./memory.js";
import { rotateLogIfLarge } from "./tenant-process.js";
import { TenantRehydrator } from "./rehydrator.js";
import { writeDesiredState, readDesiredState, type FleetLogger } from "./desired-state.js";
import { UNAVAILABLE_MESSAGE, handlePaperStart, handlePaperStop, handlePaperStatus, startHostedEngine, type HostedCommandsDeps } from "./hosted-commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "test-fixtures", "fake-engine.mjs");
const REPO = path.resolve(__dirname, "..", "..");

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hard-"));
const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const inv = (): EngineInvocation => ({
  buildStart: () => ({ command: process.execPath, args: [FIXTURE, "start"], cwd: __dirname }),
  buildStop: () => ({ command: process.execPath, args: [FIXTURE, "stop"], cwd: __dirname }),
  readyMarker: "paper engine started",
  testEnvPassthroughPrefixes: ["FAKE_"],
});
const makeFm = (o: { tenantsRoot?: string; mem?: () => number; log?: FleetLogger; max?: number } = {}) => {
  const tenantsRoot = o.tenantsRoot ?? tmp();
  return {
    tenantsRoot,
    fm: new FleetManager({
      engineInvocation: inv(),
      tenantsRoot,
      logsRoot: tmp(),
      readAvailableMemoryBytes: o.mem ?? (() => 8 * 1024 ** 3),
      ...(o.log ? { log: o.log } : {}),
      ...(o.max !== undefined ? { maxConcurrentTenants: o.max } : {}),
    }),
  };
};
const capLog = () => {
  const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const l: FleetLogger & { lines: typeof lines } = { lines, info: (obj, msg) => void lines.push({ obj, msg }), warn: (obj, msg) => void lines.push({ obj, msg }), error: (obj, msg) => void lines.push({ obj, msg }) };
  return l;
};
const client = (id: string, user = 1) => ({ id, user_id: user, status: "active", hosting_mode: "hosted" });

async function main() {
  // ── F1a/F1b: config parsing ──
  {
    const d = parseFleetFlags({});
    check("CFG: defaults are disabled, no allow-list, 400 MB floor, no cap override", d.enabled === false && d.allowedTelegramIds === undefined && d.minFreeMemoryMb === 400 && d.maxConcurrentTenants === undefined);
    check("CFG: FLEET_ENABLED empty string is NOT enabled", parseFleetFlags({ FLEET_ENABLED: "" }).enabled === false);
    check("CFG: FLEET_ENABLED=true / 1 enable", parseFleetFlags({ FLEET_ENABLED: "true" }).enabled && parseFleetFlags({ FLEET_ENABLED: "1" }).enabled);
    check("CFG: FLEET_ENABLED=false / 0 disable", !parseFleetFlags({ FLEET_ENABLED: "false" }).enabled && !parseFleetFlags({ FLEET_ENABLED: "0" }).enabled);
    const bad = (env: NodeJS.ProcessEnv): boolean => {
      try {
        parseFleetFlags(env);
        return false;
      } catch (e) {
        return e instanceof FleetConfigError;
      }
    };
    check("CFG: invalid FLEET_ENABLED (yes/typo) fails clearly instead of defaulting", bad({ FLEET_ENABLED: "yes" }) && bad({ FLEET_ENABLED: "tru" }));
    const ids = parseFleetFlags({ FLEET_ENABLED: "true", FLEET_ALLOWED_TELEGRAM_IDS: " 123456 , 789 " });
    check("CFG: allow-list parses numeric ids", ids.allowedTelegramIds?.has("123456") === true && ids.allowedTelegramIds?.has("789") === true && ids.allowedTelegramIds?.size === 2);
    check("CFG: empty allow-list string means no allow-list", parseFleetFlags({ FLEET_ALLOWED_TELEGRAM_IDS: "  " }).allowedTelegramIds === undefined);
    check("CFG: non-numeric / empty-element allow-list entries are rejected", bad({ FLEET_ALLOWED_TELEGRAM_IDS: "123,abc" }) && bad({ FLEET_ALLOWED_TELEGRAM_IDS: "123," }) && bad({ FLEET_ALLOWED_TELEGRAM_IDS: "-5" }) && bad({ FLEET_ALLOWED_TELEGRAM_IDS: "0" }));
    check("CFG: empty FLEET_MAX_CONCURRENT_TENANTS is treated as unset", parseFleetFlags({ FLEET_MAX_CONCURRENT_TENANTS: "" }).maxConcurrentTenants === undefined);
    check("CFG: FLEET_MAX_CONCURRENT_TENANTS=3 parses; 0/abc/-1 fail", parseFleetFlags({ FLEET_MAX_CONCURRENT_TENANTS: "3" }).maxConcurrentTenants === 3 && bad({ FLEET_MAX_CONCURRENT_TENANTS: "0" }) && bad({ FLEET_MAX_CONCURRENT_TENANTS: "abc" }) && bad({ FLEET_MAX_CONCURRENT_TENANTS: "-1" }));
    check("CFG: FLEET_MIN_FREE_MEMORY_MB parses and rejects junk", parseFleetFlags({ FLEET_MIN_FREE_MEMORY_MB: "512" }).minFreeMemoryMb === 512 && bad({ FLEET_MIN_FREE_MEMORY_MB: "lots" }));

    // real config.ts boot behaviour in a subprocess
    const probe = path.join(__dirname, "test-fixtures", "config-probe.mts");
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", "tsx", probe], { encoding: "utf8", env: { ...process.env, ...extra }, cwd: REPO });
    const okRun = run({ FLEET_MAX_CONCURRENT_TENANTS: "" });
    check("CFG-BOOT: blank FLEET_MAX_CONCURRENT_TENANTS boots and is unset", okRun.status === 0 && /MAX=undefined/.test(okRun.stdout) && /ENABLED=false/.test(okRun.stdout));
    const badRun = run({ FLEET_ENABLED: "maybe" });
    check("CFG-BOOT: invalid FLEET_ENABLED refuses to boot with a clear message", badRun.status !== 0 && /FLEET_ENABLED/.test(badRun.stderr));
    const badIds = run({ FLEET_ALLOWED_TELEGRAM_IDS: "12x" });
    check("CFG-BOOT: invalid FLEET_ALLOWED_TELEGRAM_IDS refuses to boot", badIds.status !== 0 && /FLEET_ALLOWED_TELEGRAM_IDS/.test(badIds.stderr));
  }

  // ── F1: access policy ──
  {
    const off = createFleetAccess({ enabled: false, allowedTelegramIds: undefined, getTelegramIdForUser: async () => "1" });
    check("ACCESS: disabled fleet allows nobody (sync and async)", !off.isTelegramIdAllowed(1) && !(await off.isUserAllowed(1)));
    const open = createFleetAccess({ enabled: true, allowedTelegramIds: undefined, getTelegramIdForUser: async () => undefined });
    check("ACCESS: enabled with no allow-list allows everyone", open.isTelegramIdAllowed(42) && (await open.isUserAllowed(7)));
    const founder = createFleetAccess({ enabled: true, allowedTelegramIds: new Set(["111"]), getTelegramIdForUser: async (u) => (u === 1 ? 111 : u === 2 ? "222" : undefined) });
    check("ACCESS: allow-list admits only listed ids", founder.isTelegramIdAllowed(111) && !founder.isTelegramIdAllowed(222) && (await founder.isUserAllowed(1)) && !(await founder.isUserAllowed(2)) && !(await founder.isUserAllowed(3)));
  }

  // ── F1a: commands answer "not available" and spawn nothing ──
  {
    const spawns: string[] = [];
    const sent: string[] = [];
    const mk = (accessible: boolean) =>
      ({
        fleetManager: { getTenantStatus: () => undefined, spawnTenant: async (id: string) => (spawns.push(id), ({}) as never), stopTenant: async () => void spawns.push("stop"), getDesiredState: () => "running" },
        isFleetAccessible: () => accessible,
        getLatestActiveClientForUser: async () => ({ id: "c1", hosting_mode: "hosted" as const }),
        registerHostedClient: async () => ({ id: "c1", hosting_mode: "hosted" as const }),
        convertClientToHosted: async () => {},
        isUserApproved: async () => true,
        renewHostedEntitlementIfNeeded: async () => {},
        notify: async (_u: number, t: string) => void sent.push(t),
      }) as unknown as HostedCommandsDeps;
    const closed = mk(false);
    await handlePaperStart(closed, { telegramUserId: 5, userId: 5 });
    await handlePaperStop(closed, { telegramUserId: 5, userId: 5 });
    await handlePaperStatus(closed, { telegramUserId: 5, userId: 5 });
    check("GATE: disabled/not-allowed -> all three commands reply the generic unavailable message", sent.length === 3 && sent.every((t) => t === UNAVAILABLE_MESSAGE));
    check("GATE: nothing was spawned or stopped", spawns.length === 0);
    sent.length = 0;
    await handlePaperStart(mk(true), { telegramUserId: 5, userId: 5 });
    check("GATE: an allowed user's /paper_start proceeds (spawns)", spawns.includes("c1") && sent[0] !== UNAVAILABLE_MESSAGE);
  }

  // ── F1b: rehydration + periodic check enforce the allow-list; kill switch off => nothing ──
  {
    const root = tmp();
    for (const id of ["al-founder", "al-other"]) writeDesiredState(root, id, "running");
    const { fm } = makeFm({ tenantsRoot: root });
    const access = createFleetAccess({ enabled: true, allowedTelegramIds: new Set(["111"]), getTelegramIdForUser: async (u) => (u === 1 ? "111" : "222") });
    const rh = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => client(id, id === "al-founder" ? 1 : 2),
      isUserApproved: async (u) => (await access.isUserAllowed(u)) && true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
    });
    await rh.rehydrateTenants();
    check("ALLOW-REHYDRATE: listed user's tenant is rehydrated", await waitFor(() => fm.getTenantStatus("al-founder")?.status === "running"));
    check("ALLOW-REHYDRATE: unlisted user's tenant is NOT spawned and desired is stopped", fm.getTenantStatus("al-other") === undefined && fm.getDesiredState("al-other") === "stopped");
    // tenant of a user who is no longer allowed gets stopped by the periodic check
    await fm.spawnTenant("al-late");
    await waitFor(() => fm.getTenantStatus("al-late")?.status === "running");
    const rh2 = new TenantRehydrator({
      fleet: fm,
      getClientById: async (id) => client(id, id === "al-founder" ? 1 : 2),
      isUserApproved: async (u) => (await access.isUserAllowed(u)) && true,
      renewHostedEntitlementIfNeeded: async () => {},
    });
    await rh2.checkApprovals();
    check("ALLOW-CHECK: running tenant of a no-longer-allowed user is stopped (desired=stopped)", fm.getTenantStatus("al-late")?.status === "stopped" && fm.getDesiredState("al-late") === "stopped");
    check("ALLOW-CHECK: allowed user's tenant keeps running", fm.getTenantStatus("al-founder")?.status === "running");
    await fm.shutdownAll({ timeoutMs: 4000 });
  }

  // ── F1c: stop-all core ──
  {
    const root = tmp();
    const { fm } = makeFm({ tenantsRoot: root });
    for (const id of ["ka-1", "ka-2"]) await fm.spawnTenant(id);
    writeDesiredState(root, "ka-queued", "running"); // exists only as a file (waiting for rehydration)
    await waitFor(() => ["ka-1", "ka-2"].every((i) => fm.getTenantStatus(i)?.status === "running"));
    const pids = ["ka-1", "ka-2"].map((i) => fm.getTenantStatus(i)!.pid!);
    const res = await fm.stopAllTenants();
    check("KILL-ALL: reports the number of tenants processed (live + queued)", res.count === 3);
    check("KILL-ALL: every live process is gone", pids.every((p) => !alive(p)) && ["ka-1", "ka-2"].every((i) => fm.getTenantStatus(i)?.status === "stopped"));
    check("KILL-ALL: desired=stopped for ALL (including the queued one)", ["ka-1", "ka-2", "ka-queued"].every((i) => readDesiredState(root, i)?.desired === "stopped"));
    check("KILL-ALL: nothing is left for rehydration", fm.scanDesiredRunning().length === 0);
  }

  // ── F3: default cap + memory guard ──
  {
    const { fm } = makeFm();
    for (const id of ["cap-1", "cap-2", "cap-3"]) await fm.spawnTenant(id);
    let capErr = false;
    try {
      await fm.spawnTenant("cap-4");
    } catch (e) {
      capErr = e instanceof FleetCapacityError && e.limit === 3;
    }
    check("CAP: default concurrent-tenant cap is 3", capErr);
    await fm.shutdownAll({ timeoutMs: 4000 });

    let mem = 100 * 1024 * 1024;
    const root = tmp();
    const log = capLog();
    const g = makeFm({ tenantsRoot: root, mem: () => mem, log });
    let lowErr = false;
    try {
      await g.fm.spawnTenant("mem-1");
    } catch (e) {
      lowErr = e instanceof FleetLowMemoryError;
    }
    check("MEM: spawn below the free-memory floor is refused with FleetLowMemoryError", lowErr);
    check("MEM: refusal creates no handle and writes no desired state", g.fm.getTenantStatus("mem-1") === undefined && g.fm.getDesiredState("mem-1") === undefined);
    const deps = {
      fleetManager: g.fm,
      getLatestActiveClientForUser: async () => ({ id: "mem-1", hosting_mode: "hosted" as const }),
      registerHostedClient: async () => ({ id: "mem-1", hosting_mode: "hosted" as const }),
      convertClientToHosted: async () => {},
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      notify: async () => {},
    } as unknown as HostedCommandsDeps;
    const r = await startHostedEngine(deps, 1);
    check("MEM: user sees the generic capacity message (no memory internals)", !r.ok && r.reason === "capacity" && !/memory|MB/i.test(r.message));

    // rehydration: stays queued with desired untouched, then starts once memory frees
    writeDesiredState(root, "mem-2", "running");
    const rh = new TenantRehydrator({
      fleet: g.fm,
      getClientById: async (id) => client(id),
      isUserApproved: async () => true,
      renewHostedEntitlementIfNeeded: async () => {},
      staggerMs: 0,
      log,
    });
    await rh.rehydrateTenants();
    await rh.rehydrateTenants();
    check("MEM: rehydration keeps the tenant queued with desired=running", g.fm.getDesiredState("mem-2") === "running" && g.fm.getTenantStatus("mem-2") === undefined && rh.counts().queued === 1);
    check("MEM: low-memory wait is logged once", log.lines.filter((l) => l.obj.reason === "low-memory").length === 1);
    mem = 8 * 1024 ** 3;
    await rh.rehydrateTenants();
    check("MEM: starts once memory is available", await waitFor(() => g.fm.getTenantStatus("mem-2")?.status === "running"));
    mem = 1; // already-admitted tenants are not killed or blocked from status
    check("MEM: a running tenant is unaffected by later low memory", g.fm.getTenantStatus("mem-2")?.status === "running");
    await g.fm.shutdownAll({ timeoutMs: 4000 });
  }

  // memory reader
  {
    const files = (m: Record<string, string>) => (p: string) => {
      if (p in m) return m[p]!;
      throw new Error("ENOENT");
    };
    const GB = 1024 ** 3;
    check("MEMREAD: cgroup v2 limit minus usage (when smaller than host free)", readAvailableMemoryBytes(files({ "/sys/fs/cgroup/memory.max": String(2 * GB), "/sys/fs/cgroup/memory.current": String(1.5 * GB) }), () => 16 * GB) === 0.5 * GB);
    check("MEMREAD: cgroup v2 'max' falls back to os.freemem", readAvailableMemoryBytes(files({ "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/memory.current": "123" }), () => 3 * GB) === 3 * GB);
    check("MEMREAD: cgroup v1 limit minus usage", readAvailableMemoryBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(1 * GB), "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(0.25 * GB) }), () => 16 * GB) === 0.75 * GB);
    check("MEMREAD: cgroup v1 'unlimited' sentinel is ignored", readAvailableMemoryBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712", "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1000" }), () => 5 * GB) === 5 * GB);
    check("MEMREAD: no cgroup files -> os.freemem; the smaller of cgroup/host wins", readAvailableMemoryBytes(files({}), () => 7 * GB) === 7 * GB && readAvailableMemoryBytes(files({ "/sys/fs/cgroup/memory.max": String(8 * GB), "/sys/fs/cgroup/memory.current": "0" }), () => 1 * GB) === 1 * GB);
  }

  // ── F7: log rotation ──
  {
    const d = tmp();
    const big = path.join(d, "t.log");
    fs.writeFileSync(big, "x".repeat(50));
    fs.writeFileSync(big + ".1", "old");
    check("LOG: oversize log is rotated to .1 (replacing the older generation)", rotateLogIfLarge(big, 10) && !fs.existsSync(big) && fs.readFileSync(big + ".1", "utf8").length === 50);
    fs.writeFileSync(big, "tiny");
    check("LOG: a small log is left alone", !rotateLogIfLarge(big, 10) && fs.existsSync(big));
    check("LOG: a missing log is a quiet no-op", !rotateLogIfLarge(path.join(d, "nope.log"), 10));
  }

  // ── F4: credential scrubbing for package-engine child processes ──
  {
    const envMod = await import(pathToFileURL(path.join(REPO, "scripts", "package-engine-env.mjs")).href);
    const scrubbed = envMod.scrubbedChildEnv({ PATH: "/bin", HOME: "/h", ARIA_ENGINE_GIT_TOKEN: "tok", GITHUB_TOKEN: "g", GH_TOKEN: "g2", NPM_TOKEN: "n", NODE_AUTH_TOKEN: "n2", GIT_ASKPASS: "a", GIT_PASSWORD: "p", npm_config__authToken: "x", ARIA_ENGINE_COMMIT_SHA: "abc" });
    check("SCRUB: git/registry credentials are removed", !("ARIA_ENGINE_GIT_TOKEN" in scrubbed) && !("GITHUB_TOKEN" in scrubbed) && !("GH_TOKEN" in scrubbed) && !("NPM_TOKEN" in scrubbed) && !("NODE_AUTH_TOKEN" in scrubbed) && !("GIT_ASKPASS" in scrubbed) && !("GIT_PASSWORD" in scrubbed) && !("npm_config__authToken" in scrubbed));
    check("SCRUB: ordinary variables are kept", scrubbed.PATH === "/bin" && scrubbed.HOME === "/h" && scrubbed.ARIA_ENGINE_COMMIT_SHA === "abc");

    // End to end: run the real package-engine.mjs against a throwaway local git repo with a
    // shim `npm` that records whether the token is visible to the install step.
    const work = tmp();
    const src = path.join(work, "src-repo");
    fs.mkdirSync(path.join(src, "src", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(src, "src", "cli.ts"), "// cli\n");
    fs.writeFileSync(path.join(src, "src", "runtime", "paths.ts"), "// ARIA_RUNTIME_DIR\n");
    fs.writeFileSync(path.join(src, "package.json"), "{}\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: src, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
    git("init", "-q", ".");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const sha = git("rev-parse", "HEAD");
    const shim = path.join(work, "shim");
    fs.mkdirSync(shim);
    const out = path.join(work, "npm-saw-token.txt");
    if (process.platform === "win32") fs.writeFileSync(path.join(shim, "npm.cmd"), `@echo off\r\necho TOKEN=[%ARIA_ENGINE_GIT_TOKEN%]>"%SHIM_OUT%"\r\nexit /b 0\r\n`);
    else {
      fs.writeFileSync(path.join(shim, "npm"), `#!/bin/sh\necho "TOKEN=[$ARIA_ENGINE_GIT_TOKEN]" > "$SHIM_OUT"\n`, { mode: 0o755 });
    }
    const DUMMY = "dummy-token-for-test-9f3a";
    const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "package-engine.mjs"), "--sha", sha, "--url", src, "--dest", path.join(work, "dest")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, SHIM_OUT: out, ARIA_ENGINE_GIT_TOKEN: DUMMY },
    });
    const saw = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    check("SCRUB-E2E: package-engine ran and invoked the install step (positive control)", r.status === 0 && /TOKEN=/.test(saw));
    check("SCRUB-E2E: the token is NOT visible in npm ci's environment", !saw.includes(DUMMY));
    // every child-process spawn in the script must pass the scrubbed env
    const script = fs.readFileSync(path.join(REPO, "scripts", "package-engine.mjs"), "utf8");
    const spawnSites = (script.match(/execFileSync\(/g) ?? []).length;
    const scrubSites = (script.match(/env: scrubbedChildEnv\(\)/g) ?? []).length;
    check("SCRUB-STATIC: every execFileSync call site passes the scrubbed env", spawnSites >= 2 && scrubSites === spawnSites);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nall deploy-hardening checks passed");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
