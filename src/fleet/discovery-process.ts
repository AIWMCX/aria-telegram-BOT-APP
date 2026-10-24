import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { NOOP_LOGGER, type FleetLogger } from "./desired-state.js";
import type { DiscoveryPaths, DiscoveryStreamEndpoints } from "./discovery-config.js";
import { MAX_TENANT_LOG_BYTES, rotateLogIfLarge, TENANT_ENV_ALLOWLIST } from "./tenant-process.js";

/**
 * Supervisor for the ONE shared discovery process (PR B2): spawns
 * `aria discovery run --out <feed>` from the packaged engine, restarts it
 * with exponential backoff, and reports URL-free health for /healthz.
 *
 * The streaming endpoints embed a provider key. They reach exactly one
 * place: THIS child's environment (buildDiscoveryEnv). Tenants are built by
 * buildTenantEnv, which never forwards them. The child's stdout/stderr are
 * line-redacted before they touch the log file, and nothing here puts a URL
 * into a log record, an error, or the health block.
 */

/** The engine tree must contain the shared-discovery command + config key; an older pinned engine does not and would crash-loop. */
export const DISCOVERY_ENGINE_MARKERS: readonly string[] = [
  path.join("src", "discovery", "stream", "discovery-service.ts"),
  path.join("src", "discovery", "stream", "discovery-source-config.ts"),
];

export function engineSupportsDiscovery(enginePath: string): boolean {
  return DISCOVERY_ENGINE_MARKERS.every((m) => existsSync(path.join(enginePath, m)));
}

/**
 * The discovery child's environment: the same operating-system basics every
 * tenant gets, its OWN runtime dir, and exactly the two stream variables,
 * taken from the validated endpoints (never copied from the parent
 * environment by name or pattern, so nothing else can ride along).
 */
export function buildDiscoveryEnv(
  parentEnv: NodeJS.ProcessEnv,
  runtimeDir: string,
  endpoints: DiscoveryStreamEndpoints,
): Record<string, string> {
  const allowed = new Set(TENANT_ENV_ALLOWLIST);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) out[key] = value;
  }
  out.ARIA_RUNTIME_DIR = runtimeDir;
  out.ARIA_STREAM_RPC_URL = endpoints.wssUrl;
  out.ARIA_STREAM_RPC_HTTP_URL = endpoints.httpUrl;
  return out;
}

const MIN_FRAGMENT = 6;

/** Every substring of the endpoints that could be (or contain) the key: whole URLs, path, query, query values, path segments, userinfo, and a token-looking first host label. */
export function secretFragments(endpoints: DiscoveryStreamEndpoints): string[] {
  const frags = new Set<string>();
  const add = (s: string | undefined) => { if (s && s.length >= MIN_FRAGMENT) frags.add(s); };
  for (const raw of [endpoints.wssUrl, endpoints.httpUrl]) {
    add(raw);
    let u: URL;
    try { u = new URL(raw); } catch { continue; }
    add(u.username); add(u.password);
    if (u.pathname !== "/") { add(u.pathname); for (const seg of u.pathname.split("/")) add(seg); }
    if (u.search) { add(u.search.slice(1)); for (const [, v] of u.searchParams) add(v); }
    const first = u.hostname.split(".")[0] ?? "";
    if (u.hostname.includes(".") && first.length >= 16 && /[A-Za-z]/.test(first) && /[0-9]/.test(first)) add(first);
  }
  // Longest first so a long fragment is replaced whole before its own sub-fragments.
  return [...frags].sort((a, b) => b.length - a.length);
}

export function redactLine(line: string, fragments: readonly string[]): string {
  let out = line;
  for (const f of fragments) if (out.includes(f)) out = out.split(f).join("<redacted>");
  return out;
}

/** Splits a byte stream into lines, redacts each COMPLETE line, so a secret split across two chunks is still caught. */
class RedactingLineWriter {
  private pending = "";
  constructor(private readonly sink: WriteStream, private readonly fragments: readonly string[]) {}
  write(chunk: Buffer | string): void {
    this.pending += chunk.toString();
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      this.sink.write(redactLine(this.pending.slice(0, nl), this.fragments) + "\n");
      this.pending = this.pending.slice(nl + 1);
    }
    // A single enormous unterminated line: redact and flush rather than buffer without bound.
    if (this.pending.length > 64 * 1024) { this.sink.write(redactLine(this.pending, this.fragments) + "\n"); this.pending = ""; }
  }
  flush(): void {
    if (this.pending.length > 0) this.sink.write(redactLine(this.pending, this.fragments) + "\n");
    this.pending = "";
  }
}

export type DiscoveryState = "starting" | "running" | "backoff" | "stopping" | "stopped";

export interface DiscoveryInvocation { command: string; args: string[]; cwd: string }

export interface DiscoveryProcessOptions {
  enginePath: string;
  endpoints: DiscoveryStreamEndpoints;
  paths: DiscoveryPaths;
  parentEnv?: NodeJS.ProcessEnv;
  /** Test seam; default runs the packaged engine CLI exactly like tenants do. */
  invocation?: (feedPath: string) => DiscoveryInvocation;
  /** Substring on stdout that marks the child as running. */
  readyMarker?: string;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  sustainedHealthyMs?: number;
  /** Producer heartbeat older than this is reported as stale. */
  heartbeatStaleMs?: number;
  now?: () => number;
  log?: FleetLogger;
}

export function realDiscoveryInvocation(enginePath: string): (feedPath: string) => DiscoveryInvocation {
  return (feedPath) => ({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "discovery", "run", "--out", feedPath],
    cwd: enginePath,
  });
}

/** The /healthz `discovery` block. Whitelisted scalars only: no URL, host, path, key or env value can appear here. */
export interface DiscoveryHealthBlock {
  enabled: boolean;
  running: boolean;
  state?: DiscoveryState;
  reason?: string;
  restarts?: number;
  consecutiveCrashes?: number;
  /** Age of the last launch the producer wrote; null = none yet (or no readable health file). */
  lastEventAgeMs?: number | null;
  /** Age of the producer's own heartbeat (health file refresh, every 10 s). */
  heartbeatAgeMs?: number | null;
  stale?: boolean;
  counters?: Record<string, number | boolean>;
  programsWatched?: { watched: number; total: number };
}

const COUNTER_KEYS = ["connected", "reconnects", "eventsSeen", "candidates", "decoded", "duplicates", "undecodable", "subscribeErrors", "authFailures", "programStaleReconnects", "fetchFailures"] as const;

export class DiscoveryProcess {
  private child: ChildProcess | undefined;
  private state: DiscoveryState = "stopped";
  private restarts = 0;
  private consecutiveCrashes = 0;
  private runningSince: number | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private logStream: WriteStream | undefined;
  private writers: RedactingLineWriter[] = [];
  private exitWaiters: Array<() => void> = [];

  private readonly opts: Required<Pick<DiscoveryProcessOptions, "restartBackoffMs" | "maxRestartBackoffMs" | "sustainedHealthyMs" | "heartbeatStaleMs" | "readyMarker" | "now" | "log">> & DiscoveryProcessOptions;
  private readonly fragments: readonly string[];

  constructor(opts: DiscoveryProcessOptions) {
    this.opts = {
      restartBackoffMs: 5000,
      maxRestartBackoffMs: 5 * 60 * 1000,
      sustainedHealthyMs: 60 * 1000,
      heartbeatStaleMs: 60 * 1000,
      readyMarker: "discovery service started",
      now: () => Date.now(),
      log: NOOP_LOGGER,
      ...opts,
    };
    this.fragments = secretFragments(opts.endpoints);
    liveDiscoveryProcesses.add(this);
    installDiscoveryExitHook();
  }

  get pid(): number | undefined { return this.child?.pid; }

  /** Starts supervising. Refuses (returns false, logs why) if the packaged engine lacks the command. */
  start(): boolean {
    if (this.state !== "stopped") return true;
    if (!engineSupportsDiscovery(this.opts.enginePath)) {
      this.opts.log.error({}, "shared discovery NOT started: the packaged engine does not contain `aria discovery run` (bump ARIA_ENGINE_COMMIT_SHA to an engine that includes it)");
      return false;
    }
    this.stopping = false;
    this.launch(false);
    return true;
  }

  private launch(isRestart: boolean): void {
    mkdirSync(this.opts.paths.runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(this.opts.paths.feedPath), { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(this.opts.paths.logPath), { recursive: true, mode: 0o700 });
    rotateLogIfLarge(this.opts.paths.logPath, MAX_TENANT_LOG_BYTES);
    this.logStream = createWriteStream(this.opts.paths.logPath, { flags: "a" });
    const inv = (this.opts.invocation ?? realDiscoveryInvocation(this.opts.enginePath))(this.opts.paths.feedPath);
    this.state = "starting";
    if (isRestart) this.restarts += 1;

    const child = spawn(inv.command, inv.args, {
      cwd: inv.cwd,
      env: buildDiscoveryEnv(this.opts.parentEnv ?? process.env, this.opts.paths.runtimeDir, this.opts.endpoints),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const out = new RedactingLineWriter(this.logStream, this.fragments);
    const err = new RedactingLineWriter(this.logStream, this.fragments);
    this.writers = [out, err];
    let ready = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      if (!ready && chunk.toString("utf8").includes(this.opts.readyMarker)) {
        ready = true;
        if (this.state === "starting") this.state = "running";
        this.runningSince = this.opts.now();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => err.write(chunk));
    child.once("error", () => { /* spawn failure surfaces as an 'exit'-less child; handled as a crash below */ this.onExit(child, null, null); });
    child.once("exit", (code, signal) => this.onExit(child, code, signal));
    this.opts.log.info({ pid: child.pid, restart: isRestart }, "shared discovery process started");
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return; // already handled (error then exit)
    this.child = undefined;
    for (const w of this.writers) w.flush();
    this.writers = [];
    this.logStream?.end();
    this.logStream = undefined;
    const waiters = this.exitWaiters; this.exitWaiters = [];
    for (const w of waiters) w();

    if (this.stopping) {
      this.state = "stopped";
      this.runningSince = undefined;
      this.opts.log.info({ code, signal }, "shared discovery process stopped");
      return;
    }
    const ranHealthyMs = this.runningSince !== undefined ? this.opts.now() - this.runningSince : 0;
    this.runningSince = undefined;
    if (ranHealthyMs >= this.opts.sustainedHealthyMs) this.consecutiveCrashes = 0;
    this.consecutiveCrashes += 1;
    this.state = "backoff";
    const backoffMs = Math.min(this.opts.restartBackoffMs * 2 ** (this.consecutiveCrashes - 1), this.opts.maxRestartBackoffMs);
    this.opts.log.warn({ code, signal, retryInMs: backoffMs, consecutiveCrashes: this.consecutiveCrashes }, "shared discovery process exited unexpectedly; restarting with backoff");
    // Unlike a tenant there is no give-up: every tenant depends on this one feed, so it keeps retrying at the capped delay.
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping || this.state !== "backoff") return;
      this.launch(true);
    }, backoffMs);
    this.restartTimer.unref?.();
  }

  /** Graceful stop: SIGTERM (the engine flushes in-flight launches and exits 0), SIGKILL at 75% of the budget. Does not touch any tenant desired state. */
  async stop(timeoutMs: number): Promise<{ wasRunning: boolean; killed: boolean }> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const child = this.child;
    if (!child) { this.state = "stopped"; return { wasRunning: false, killed: false }; }
    this.state = "stopping";
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    const settle = (ms: number) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.max(0, ms));
      void exited.then(() => { clearTimeout(t); resolve(); });
    });
    const startedAt = Date.now();
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await settle(timeoutMs * 0.75);
    let killed = false;
    if (this.child === child) {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await settle(timeoutMs - (Date.now() - startedAt));
    }
    return { wasRunning: true, killed };
  }

  /** Last-resort synchronous kill (process 'exit' hook). */
  killSync(): void {
    try { this.child?.kill("SIGKILL"); } catch { /* already gone */ }
  }

  /** URL-free status for /healthz. Reads the producer's own `<feed>.health.json` and trusts it only if its pid is this child's. */
  health(): DiscoveryHealthBlock {
    const running = this.state === "running" && this.child !== undefined;
    const block: DiscoveryHealthBlock = {
      enabled: true,
      running,
      state: this.state,
      restarts: this.restarts,
      consecutiveCrashes: this.consecutiveCrashes,
      lastEventAgeMs: null,
      heartbeatAgeMs: null,
      stale: true,
    };
    try {
      const raw = JSON.parse(readFileSync(`${this.opts.paths.feedPath}.health.json`, "utf8")) as Record<string, any>;
      if (this.child?.pid !== undefined && raw.pid === this.child.pid) {
        const t = this.opts.now();
        if (typeof raw.lastEventAt === "number") block.lastEventAgeMs = Math.max(0, t - raw.lastEventAt);
        if (typeof raw.updatedAt === "number") block.heartbeatAgeMs = Math.max(0, t - raw.updatedAt);
        block.stale = block.heartbeatAgeMs == null || block.heartbeatAgeMs > this.opts.heartbeatStaleMs;
        const counters: Record<string, number | boolean> = {};
        for (const k of COUNTER_KEYS) {
          const v = raw.counters?.[k];
          if (typeof v === "number" || typeof v === "boolean") counters[k] = v;
        }
        block.counters = counters;
        if (Array.isArray(raw.programs)) block.programsWatched = { watched: raw.programs.filter((p: any) => p?.watched === true).length, total: raw.programs.length };
      }
    } catch { /* no/partial health file: leave the defaults (stale) */ }
    return block;
  }
}

const liveDiscoveryProcesses = new Set<DiscoveryProcess>();
let exitHookInstalled = false;
function installDiscoveryExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => { for (const p of liveDiscoveryProcesses) p.killSync(); });
}
