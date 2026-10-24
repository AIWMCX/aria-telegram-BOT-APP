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
import { parseDiscoveryFlags, parseEventStaleMs, discoveryPaths } from "./discovery-config.js";
import { DiscoveryProcess, buildDiscoveryEnv, engineSupportsDiscovery, redactLine, secretFragments, DISCOVERY_ENGINE_MARKERS, DISCOVERY_FILETAIL_MARKER } from "./discovery-process.js";
import { reconcileTenantDiscovery, reconcileTenantDiscoverySync } from "./tenant-discovery-seed.js";
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
  check("marker files alone (an engine pinned before discovery.fileTail) -> NOT supported", !engineSupportsDiscovery(root));
  fs.mkdirSync(path.dirname(path.join(root, DISCOVERY_FILETAIL_MARKER.file)), { recursive: true });
  fs.writeFileSync(path.join(root, DISCOVERY_FILETAIL_MARKER.file), "case 'discovery.source':");
  check("runtime-config without the discovery.fileTail key -> NOT supported", !engineSupportsDiscovery(root));
  fs.writeFileSync(path.join(root, DISCOVERY_FILETAIL_MARKER.file), 'case "discovery.fileTail":');
  check("engineSupportsDiscovery needs the command files AND the discovery.fileTail key", engineSupportsDiscovery(root));
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

// ── stale when no launch for eventStaleMs, even with a fresh heartbeat; writeErrors/rotations exposed
{
  const script = `
    const fs = require('fs'); const feed = process.argv[1];
    const write = () => fs.writeFileSync(feed + '.health.json', JSON.stringify({ v: 1, pid: process.pid, startedAt: Date.now() - 600000, updatedAt: Date.now(), running: true, lastEventAt: Date.now() - 400000, writeErrors: 3, rotations: 2, linesWritten: 50, counters: { connected: true, decoded: 5 }, programs: [] }));
    write(); console.log('discovery service started'); setInterval(write, 100);`;
  const inv = (feed: string) => ({ command: process.execPath, args: ["-e", script, feed], cwd: root });
  const quiet = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: inv, eventStaleMs: 300_000 });
  quiet.start();
  await waitFor(() => typeof quiet.health().lastEventAgeMs === "number");
  const q = quiet.health();
  check("fresh heartbeat but no launch for > eventStaleMs -> stale:true", q.heartbeatAgeMs !== null && (q.heartbeatAgeMs ?? 0) < 5000 && q.stale === true);
  check("writeErrors, rotations (and linesWritten) are in the whitelisted counters", q.counters?.writeErrors === 3 && q.counters?.rotations === 2 && q.counters?.linesWritten === 50);
  await quiet.stop(2000);
  const lively = new DiscoveryProcess({ enginePath: root, endpoints, paths, invocation: inv, eventStaleMs: 900_000 });
  lively.start();
  await waitFor(() => typeof lively.health().lastEventAgeMs === "number");
  check("same producer under a larger threshold is not stale (threshold is configurable)", lively.health().stale === false);
  await lively.stop(2000);
  const env = (v: string | undefined) => parseEventStaleMs({ DISCOVERY_MAX_EVENT_AGE_MS: v });
  check("DISCOVERY_MAX_EVENT_AGE_MS: default 15 min, accepts >= 1 min, malformed/too small -> default", env(undefined) === 900_000 && env("120000") === 120_000 && env("abc") === 900_000 && env("10") === 900_000);
}

// ── launch failures never throw; log-file errors never crash
{
  const blocker = path.join(root, "blocker-file");
  fs.writeFileSync(blocker, "x");
  const badPaths = { feedPath: path.join(blocker, "d", "launches.ndjson"), runtimeDir: path.join(blocker, "rt"), logPath: path.join(blocker, "log", "discovery.log") };
  const dp = new DiscoveryProcess({ enginePath: root, endpoints, paths: badPaths, invocation: scriptInvocation("setInterval(() => {}, 1000)"), restartBackoffMs: 30, maxRestartBackoffMs: 60 });
  let threw = false;
  try { dp.start(); } catch { threw = true; }
  check("mkdir failure at launch does not throw; state failed", !threw && dp.health().state === "failed" && dp.health().running === false);
  check("a failed launch keeps retrying with backoff (consecutiveCrashes grows)", await waitFor(() => (dp.health().consecutiveCrashes ?? 0) >= 2));
  await dp.stop(500);
  check("stop() after failed launches ends in stopped", dp.health().state === "stopped");

  // log path is a DIRECTORY: createWriteStream emits 'error' asynchronously; must be swallowed
  const dirLog = path.join(root, "logdir-as-file");
  fs.mkdirSync(path.join(dirLog, "discovery.log"), { recursive: true });
  let uncaught = false;
  const onUncaught = () => { uncaught = true; };
  process.on("uncaughtException", onUncaught);
  const dp2 = new DiscoveryProcess({ enginePath: root, endpoints, paths: { ...paths, logPath: path.join(dirLog, "discovery.log") }, invocation: scriptInvocation("console.log('discovery service started'); setInterval(() => console.log('tick'), 50);") });
  dp2.start();
  check("child still runs when its log file errors", await waitFor(() => dp2.health().running));
  await sleep(300);
  await dp2.stop(2000);
  process.off("uncaughtException", onUncaught);
  check("a log WriteStream 'error' is handled (no uncaught exception)", !uncaught);
}

// ── tenant seeding: direct atomic edit of config.json
{
  const feed = paths.feedPath;
  const engineCfg = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, controlPlaneUrl: "https://x.example", rpc: { url: "https://r.example", fallbackUrls: [], timeoutMs: 5000 }, paper: { maxPositions: 3 }, market: { kind: "synthetic", watchlist: [] }, stream: { rpcUrl: "", rpcHttpUrl: "" }, customKey: { keep: "me" }, ...extra });
  const mkRt = (n: string) => { const d = path.join(root, "tenants", n, ".aria"); fs.mkdirSync(d, { recursive: true }); return d; };
  const read = (rt: string) => JSON.parse(fs.readFileSync(path.join(rt, "config.json"), "utf8"));

  const rt0 = mkRt("t0");
  check("no config.json yet -> deferred (engine creates its default; next spawn seeds)", reconcileTenantDiscoverySync({ runtimeDir: rt0, feedPath: feed, enabled: true }) === "deferred" && !fs.existsSync(path.join(rt0, "config.json")));
  const rt1 = mkRt("t1");
  fs.writeFileSync(path.join(rt1, "config.json"), JSON.stringify(engineCfg()), { mode: 0o600 });
  check("enabled -> file-tail + feed path written", (await reconcileTenantDiscovery({ runtimeDir: rt1, feedPath: feed, enabled: true })) === "enabled" && read(rt1).discovery.source === "file-tail" && read(rt1).discovery.path === feed);
  check("every other key is preserved byte-for-byte in meaning", JSON.stringify({ ...read(rt1), discovery: undefined }) === JSON.stringify({ ...engineCfg(), discovery: undefined }));
  check("no temp file is left behind", fs.readdirSync(rt1).every((f) => !f.includes(".tmp-")));
  if (process.platform !== "win32") check("config.json stays mode 0600", (fs.statSync(path.join(rt1, "config.json")).mode & 0o777) === 0o600);
  check("already on our feed -> unchanged (idempotent)", reconcileTenantDiscoverySync({ runtimeDir: rt1, feedPath: feed, enabled: true }) === "unchanged");
  check("discovery DISABLED + tenant on our feed -> flipped back to polling", reconcileTenantDiscoverySync({ runtimeDir: rt1, feedPath: feed, enabled: false }) === "disabled" && read(rt1).discovery.source === "polling");
  const rt2 = mkRt("t2");
  fs.writeFileSync(path.join(rt2, "config.json"), JSON.stringify(engineCfg({ discovery: { source: "file-tail", path: "/somewhere/else.ndjson", fromStart: true } })));
  check("discovery disabled + tenant on a DIFFERENT feed -> never touched", reconcileTenantDiscoverySync({ runtimeDir: rt2, feedPath: feed, enabled: false }) === "unchanged" && read(rt2).discovery.path === "/somewhere/else.ndjson");
  const rt3 = mkRt("t3");
  fs.writeFileSync(path.join(rt3, "config.json"), JSON.stringify(engineCfg({ discovery: { source: "polling", path: "", maxStaleMs: 5000 } })));
  reconcileTenantDiscoverySync({ runtimeDir: rt3, feedPath: feed, enabled: true });
  check("existing discovery options (maxStaleMs) survive enabling", read(rt3).discovery.maxStaleMs === 5000 && read(rt3).discovery.source === "file-tail");
  const rt4 = mkRt("t4");
  fs.writeFileSync(path.join(rt4, "config.json"), "{ not json");
  check("a corrupt config.json is left alone (deferred), not overwritten", reconcileTenantDiscoverySync({ runtimeDir: rt4, feedPath: feed, enabled: true }) === "deferred" && fs.readFileSync(path.join(rt4, "config.json"), "utf8") === "{ not json");
  fs.writeFileSync(path.join(rt4, "config.json"), JSON.stringify({ schemaVersion: 1, foo: 1 }));
  check("an object that does not look like an engine config is left alone", reconcileTenantDiscoverySync({ runtimeDir: rt4, feedPath: feed, enabled: true }) === "deferred" && !("discovery" in read(rt4)));
  const rt5 = mkRt("t5");
  check("discovery disabled + no config -> OFF stays OFF", reconcileTenantDiscoverySync({ runtimeDir: rt5, feedPath: feed, enabled: false }) === "deferred");
  check("the written value is a path only (no URL anywhere in the file)", !/wss?:|https?:\/\/[^"]*(api-key|key=)/.test(fs.readFileSync(path.join(rt1, "config.json"), "utf8")) && !fs.readFileSync(path.join(rt3, "config.json"), "utf8").includes(KEY));

  // Concurrent seeding of the SAME tenant never corrupts config.json
  const rt6 = mkRt("t6");
  fs.writeFileSync(path.join(rt6, "config.json"), JSON.stringify(engineCfg()));
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => reconcileTenantDiscovery({ runtimeDir: rt6, feedPath: feed, enabled: true })));
  const after = read(rt6);
  check("40 concurrent seeds of one tenant leave valid JSON, correct discovery, all other keys intact", after.discovery.source === "file-tail" && after.customKey.keep === "me" && after.paper.maxPositions === 3 && results.filter((r) => r === "enabled").length === 1 && fs.readdirSync(rt6).every((f) => !f.includes(".tmp-")));
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
  // concurrent spawnTenant(sameId) with the REAL seeding hook cannot corrupt config.json
  const rtDir = path.join(root, "fm3", "tenants", "tenant-c", ".aria");
  fs.mkdirSync(rtDir, { recursive: true });
  fs.writeFileSync(path.join(rtDir, "config.json"), JSON.stringify({ schemaVersion: 1, rpc: {}, paper: {}, market: {}, keepMe: 7 }));
  const fm3 = mk(async (_id, dir) => { reconcileTenantDiscoverySync({ runtimeDir: dir, feedPath: paths.feedPath, enabled: true }); }, "fm3");
  const hs = await Promise.all(Array.from({ length: 10 }, () => fm3.spawnTenant("tenant-c")));
  const cfg3 = JSON.parse(fs.readFileSync(path.join(rtDir, "config.json"), "utf8"));
  check("concurrent spawnTenant(sameId) x10: one process, config.json valid and seeded, other keys kept", new Set(hs.map((h) => h.pid)).size === 1 && cfg3.keepMe === 7 && cfg3.discovery?.source === "file-tail");
  await fm3.stopTenant("tenant-c", true);
  await fm3.shutdownAll({ timeoutMs: 2000 });
  await fm.shutdownAll({ timeoutMs: 2000 });
  await fm2.shutdownAll({ timeoutMs: 2000 });
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a log briefly */ }
if (failures > 0) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
