/**
 * Shared discovery supervisor (PR B2): env isolation, log redaction,
 * supervision/backoff, graceful stop, URL-free health, fail-closed config,
 * per-tenant seeding, and the FleetManager pre-spawn hook. Real child
 * processes (small node -e / fixture scripts), no real engine, no network.
 *
 * Run: npx tsx src/fleet/discovery-process.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiscoveryFlags, discoveryPaths } from "./discovery-config.js";
import { DiscoveryProcess, buildDiscoveryEnv, engineSupportsDiscovery, redactLine, secretFragments, DISCOVERY_ENGINE_MARKERS } from "./discovery-process.js";
import { reconcileTenantDiscovery } from "./tenant-discovery-seed.js";
import { FleetManager, type EngineInvocation } from "./fleet-manager.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

const KEY = "FAKEKEY9f3a1cZZ";
const WSS = `wss://stream.example.invalid/ws/${KEY}?api-key=${KEY}`;
const HTTPS = `https://rpc.example.invalid/?api-key=${KEY}`;
const endpoints = { wssUrl: WSS, httpUrl: HTTPS };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "disc-test-"));
const paths = discoveryPaths(path.join(root, "tenants"), path.join(root, "tenant-logs"));
const here = path.dirname(fileURLToPath(import.meta.url));

// ── flags: fail closed, reasons never echo a value
{
  const base = { DISCOVERY_ENABLED: "true", ARIA_STREAM_RPC_URL: WSS, ARIA_STREAM_RPC_HTTP_URL: HTTPS };
  const ok = parseDiscoveryFlags(base);
  check("both vars + DISCOVERY_ENABLED=true -> enabled", ok.enabled === true);
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ["DISCOVERY_ENABLED unset", { ...base, DISCOVERY_ENABLED: undefined }],
    ["DISCOVERY_ENABLED=false", { ...base, DISCOVERY_ENABLED: "false" }],
    ["DISCOVERY_ENABLED=yes (malformed)", { ...base, DISCOVERY_ENABLED: "yes" }],
    ["wss url missing", { ...base, ARIA_STREAM_RPC_URL: undefined }],
    ["http url missing", { ...base, ARIA_STREAM_RPC_HTTP_URL: " " }],
    ["plain ws:// to a remote host", { ...base, ARIA_STREAM_RPC_URL: `ws://remote.example/?k=${KEY}` }],
    ["plain http:// to a remote host", { ...base, ARIA_STREAM_RPC_HTTP_URL: `http://remote.example/?k=${KEY}` }],
    ["garbage url", { ...base, ARIA_STREAM_RPC_URL: `not a url ${KEY}` }],
  ];
  for (const [name, env] of cases) {
    const r = parseDiscoveryFlags(env);
    check(`fail closed: ${name} -> enabled:false with a reason, no value echoed`, !r.enabled && r.reason.length > 0 && !r.reason.includes(KEY) && !/(?:https?|wss?):[/][/]\S/.test(r.reason));
  }
  check("loopback ws/http is accepted (local mock)", parseDiscoveryFlags({ ...base, ARIA_STREAM_RPC_URL: "ws://127.0.0.1:9/", ARIA_STREAM_RPC_HTTP_URL: "http://localhost:9/" }).enabled);
}

// ── child env: exactly basics + runtime dir + the two stream vars
{
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin", HOME: "/h", TELEGRAM_BOT_TOKEN: "dummy-bot", DATABASE_URL: "postgres://u:p@h/d", STRIPE_SECRET_KEY: "sk_x",
    ARIA_LICENSE_PRIVATE_D: "dummy-priv", ARIA_STREAM_RPC_URL: "parent-should-not-leak-through-copy", RANDOM_OTHER: "x",
  };
  const env = buildDiscoveryEnv(parent, "/data/discovery/runtime", endpoints);
  check("discovery env carries the two stream vars from the validated endpoints", env.ARIA_STREAM_RPC_URL === WSS && env.ARIA_STREAM_RPC_HTTP_URL === HTTPS);
  check("discovery env carries its own runtime dir and the basics", env.ARIA_RUNTIME_DIR === "/data/discovery/runtime" && env.PATH === "/usr/bin" && env.HOME === "/h");
  const keys = Object.keys(env).sort().join(",");
  check("TLS trust vars (non-secret) pass through to the discovery child only", buildDiscoveryEnv({ NODE_EXTRA_CA_CERTS: "/ca.pem" }, "/r", endpoints).NODE_EXTRA_CA_CERTS === "/ca.pem");
  check("discovery env has NOTHING else (no control-plane secret, no stray variable)", keys === "ARIA_RUNTIME_DIR,ARIA_STREAM_RPC_HTTP_URL,ARIA_STREAM_RPC_URL,HOME,PATH");
}

// ── redaction primitives
{
  const frags = secretFragments(endpoints);
  const lines = [`connect ${WSS}`, `GET ${HTTPS} failed`, `path seg /ws/${KEY} and query api-key=${KEY}`, `plain ${KEY}`];
  check("redactLine strips the key from whole URLs, path, query and bare mentions", lines.every((l) => !redactLine(l, frags).includes(KEY)));
  check("redactLine leaves ordinary lines intact", redactLine("discovery service started", frags) === "discovery service started");
}

// ── real child: sees the stream vars, secrets never reach the log file (stdout, stderr, split across chunks)
function scriptInvocation(script: string) {
  return () => ({ command: process.execPath, args: ["-e", script], cwd: root });
}
{
  const script = `
    const e = process.env;
    console.log('ENVKEYS ' + Object.keys(e).map(k => k.toUpperCase()).sort().join(','));
    console.log('discovery service started');
    console.log('using ' + e.ARIA_STREAM_RPC_URL);
    console.error('http ' + e.ARIA_STREAM_RPC_HTTP_URL);
    const k = e.ARIA_STREAM_RPC_URL;
    process.stdout.write('split-a ' + k.slice(0, 40));
    setTimeout(() => { process.stdout.write(k.slice(40) + '\\n'); }, 60);
    setInterval(() => {}, 1000);
  `;
  process.env.TELEGRAM_BOT_TOKEN = "dummy-bot-token-not-real";
  const dp = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: scriptInvocation(script), restartBackoffMs: 30 });
  // engine marker files absent in `root` -> start() must refuse (fail closed) ...
  check("start() refuses when the packaged engine lacks the discovery command", dp.start() === false && dp.pid === undefined);
  // ... so give the fake engine tree the marker files.
  for (const m of DISCOVERY_ENGINE_MARKERS) { fs.mkdirSync(path.dirname(path.join(root, m)), { recursive: true }); fs.writeFileSync(path.join(root, m), "//"); }
  check("engineSupportsDiscovery sees the marker files", engineSupportsDiscovery(root));
  check("start() succeeds with a capable engine", dp.start() === true);
  check("child reaches running (ready marker seen)", await waitFor(() => dp.health().running));
  await sleep(250);
  const stopped = await dp.stop(3000);
  check("stop() terminates the child", stopped.wasRunning && dp.health().state === "stopped" && dp.pid === undefined);
  const log = fs.readFileSync(paths.logPath, "utf8");
  const envLine = log.split(/\r?\n/).find((l) => l.startsWith("ENVKEYS "))!;
  check("the REAL child sees both stream variables", /ARIA_STREAM_RPC_URL/.test(envLine) && /ARIA_STREAM_RPC_HTTP_URL/.test(envLine));
  check("the REAL child does not see TELEGRAM_BOT_TOKEN or any control-plane secret", !/TELEGRAM_BOT_TOKEN|DATABASE_URL|STRIPE|PRIVATE_D/.test(envLine));
  check("discovery.log never contains the key (stdout, stderr, or a URL split across chunks)", !log.includes(KEY) && log.includes("<redacted>"));
  check("discovery.log is at <logsRoot>/discovery.log", paths.logPath === path.join(path.resolve(root, "tenant-logs"), "discovery.log"));
  delete process.env.TELEGRAM_BOT_TOKEN;
}

// ── supervision: crash -> backoff -> restart; counters; no restart after stop
{
  const dp = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: scriptInvocation("console.log('discovery service started'); setTimeout(() => process.exit(1), 80);"), restartBackoffMs: 40, maxRestartBackoffMs: 160, sustainedHealthyMs: 60_000 });
  dp.start();
  check("a crashing child is restarted (restarts counter increments)", await waitFor(() => (dp.health().restarts ?? 0) >= 2, 10_000));
  const h = dp.health();
  check("consecutive crashes accumulate while it keeps failing", (h.consecutiveCrashes ?? 0) >= 2);
  await dp.stop(2000);
  const after = dp.health().restarts;
  await sleep(400);
  check("no restart after stop()", dp.health().restarts === after && dp.pid === undefined);
}

// ── graceful stop: SIGTERM first (POSIX), the child's own shutdown output is kept
{
  const script = `
    console.log('discovery service started');
    process.on('SIGTERM', () => { console.log('flushing on SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);`;
  const dp = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: scriptInvocation(script) });
  dp.start();
  await waitFor(() => dp.health().running);
  const r = await dp.stop(4000);
  check("stop() on a SIGTERM-handling child does not need SIGKILL", r.wasRunning && (r.killed === false || process.platform === "win32"));
  if (process.platform !== "win32") check("the child received SIGTERM and flushed", fs.readFileSync(paths.logPath, "utf8").includes("flushing on SIGTERM"));
  const dp2 = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: scriptInvocation("console.log('discovery service started'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);") });
  dp2.start();
  await waitFor(() => dp2.health().running);
  const r2 = await dp2.stop(800);
  check("a child that ignores SIGTERM is SIGKILLed within the budget", r2.killed === true || process.platform === "win32");
  check("stop() on a never-started supervisor is a safe no-op", (await new DiscoveryProcess({ enginePath: root, endpoints, paths }).stop(100)).wasRunning === false);
}

// ── health block: whitelisted, URL-free, pid-matched
{
  const script = `
    const fs = require('fs'); const feed = process.argv[1];
    const write = () => fs.writeFileSync(feed + '.health.json', JSON.stringify({
      v: 1, pid: process.pid, startedAt: Date.now() - 5000, updatedAt: Date.now() - 2000, running: true, lastEventAt: Date.now() - 7000,
      counters: { connected: true, reconnects: 1, eventsSeen: 100, decoded: 9, authFailures: 0, secretLeak: 'https://leak.example/?k=${KEY}' },
      programs: [{ programId: 'a', watched: true }, { programId: 'b', watched: false }, { programId: 'c', watched: true }],
      endpoint: '${WSS}' }));
    write(); console.log('discovery service started'); setInterval(write, 100);`;
  const dp = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: (feed) => ({ command: process.execPath, args: ["-e", script, feed], cwd: root }) });
  dp.start();
  check("health reports running with restarts and lastEventAgeMs", await waitFor(() => { const h = dp.health(); return h.running && typeof h.lastEventAgeMs === "number"; }));
  const h = dp.health();
  check("lastEventAgeMs / heartbeatAgeMs derived from the producer's health file", (h.lastEventAgeMs ?? 0) >= 6900 && (h.heartbeatAgeMs ?? 0) >= 1900 && h.stale === false);
  check("counters are the whitelisted subset only", h.counters?.decoded === 9 && h.counters?.connected === true && !("secretLeak" in (h.counters ?? {})));
  check("programsWatched summarised without program ids", h.programsWatched?.watched === 2 && h.programsWatched?.total === 3);
  const json = JSON.stringify(h);
  check("the health block contains no URL, host or key", !json.includes(KEY) && !/https?:|wss?:|example\.invalid|leak/.test(json));
  await dp.stop(2000);
  // A health file from ANOTHER pid (previous run) must not be trusted
  fs.writeFileSync(`${paths.feedPath}.health.json`, JSON.stringify({ pid: 1, updatedAt: Date.now(), lastEventAt: Date.now(), counters: { decoded: 1 } }));
  const dp3 = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: scriptInvocation("console.log('discovery service started'); setInterval(() => {}, 1000);") });
  dp3.start();
  await waitFor(() => dp3.health().running);
  check("a stale health file from another pid is ignored (stale:true, no age)", dp3.health().stale === true && dp3.health().lastEventAgeMs === null);
  await dp3.stop(2000);
}

// ── tenant seeding
{
  const rt = path.join(root, "tenants", "t1", ".aria");
  fs.mkdirSync(rt, { recursive: true });
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); };
  const feed = paths.feedPath;
  check("enabled + no config -> sets discovery.fileTail to the feed path (path only)", (await reconcileTenantDiscovery({ runtimeDir: rt, feedPath: feed, enabled: true, run })) === "enabled" && calls[0]!.join(" ") === `config set discovery.fileTail ${feed}`);
  fs.writeFileSync(path.join(rt, "config.json"), JSON.stringify({ discovery: { source: "file-tail", path: feed } }));
  check("already on our feed -> unchanged (idempotent)", (await reconcileTenantDiscovery({ runtimeDir: rt, feedPath: feed, enabled: true, run })) === "unchanged" && calls.length === 1);
  check("discovery DISABLED + tenant on our feed -> flipped back to polling", (await reconcileTenantDiscovery({ runtimeDir: rt, feedPath: feed, enabled: false, run })) === "disabled" && calls[1]!.join(" ") === "config set discovery.source polling");
  fs.writeFileSync(path.join(rt, "config.json"), JSON.stringify({ discovery: { source: "file-tail", path: "/somewhere/else.ndjson" } }));
  check("discovery disabled + tenant on a DIFFERENT feed -> never touched", (await reconcileTenantDiscovery({ runtimeDir: rt, feedPath: feed, enabled: false, run })) === "unchanged" && calls.length === 2);
  fs.rmSync(path.join(rt, "config.json"));
  check("discovery disabled + no config -> OFF stays OFF (no engine call at all)", (await reconcileTenantDiscovery({ runtimeDir: rt, feedPath: feed, enabled: false, run })) === "unchanged" && calls.length === 2);
  check("no argument handed to the engine contains a stream URL/key", calls.every((c) => !c.join(" ").includes(KEY) && !/wss?:|https?:/.test(c.join(" "))));
}

// ── FleetManager pre-spawn hook: runs before the spawn, failure is non-fatal
{
  const FIXTURE = path.join(here, "test-fixtures", "fake-engine.mjs");
  const inv: EngineInvocation = {
    buildStart: () => ({ command: process.execPath, args: [FIXTURE, "start"], cwd: here }),
    buildStop: () => ({ command: process.execPath, args: [FIXTURE, "stop"], cwd: here }),
    readyMarker: "paper engine started",
  };
  const mk = (hook: (id: string, dir: string) => Promise<void>, sub: string) => new FleetManager({
    engineInvocation: inv, tenantsRoot: path.join(root, sub, "tenants"), logsRoot: path.join(root, sub, "logs"),
    minFreeMemoryBytes: 0, prepareTenantRuntime: hook, restartBackoffMs: 50,
  });
  const seen: string[] = [];
  const fm = mk(async (id, dir) => { seen.push(`${id}|${dir}`); }, "fm1");
  await fm.spawnTenant("tenant-a");
  check("prepareTenantRuntime is called with the tenant's runtime dir before the spawn", seen.length === 1 && seen[0]!.startsWith("tenant-a|") && seen[0]!.endsWith(path.join("tenant-a", ".aria")));
  await fm.stopTenant("tenant-a", true);
  const fm2 = mk(async () => { throw new Error("engine config set failed"); }, "fm2");
  const handle = await fm2.spawnTenant("tenant-b");
  check("a failing preparation hook does not block the tenant from starting", handle.status === "starting" || handle.status === "running");
  await fm2.stopTenant("tenant-b", true);
  await fm.shutdownAll({ timeoutMs: 2000 });
  await fm2.shutdownAll({ timeoutMs: 2000 });
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a log briefly */ }
if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
