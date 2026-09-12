import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * One spawned child's lifecycle wrapper — owns the actual `child_process`
 * handle, its dedicated log file, and the readiness signal FleetManager
 * needs (has the child printed the engine's own "started" line yet?).
 *
 * Deliberately dumb: this class does not know about restart policy,
 * backoff, or multi-tenant bookkeeping — that's FleetManager's job. This
 * class's only responsibilities are: spawn one process with the right
 * env, capture its stdout/stderr to ONE file that never mixes with any
 * other tenant's or the Fleet Manager's own process output, and report
 * exit/ready events.
 */

export interface TenantProcessSpawnOptions {
  clientId: string;
  /** Executable to run (e.g. `process.execPath` to spawn node/tsx, or the fake fixture directly). */
  command: string;
  /** Args to that executable, e.g. `["--import", "tsx", "cli.ts", "paper", "start"]`. */
  args: string[];
  /** cwd the child is spawned in (e.g. the aria-engine repo checkout). */
  cwd: string;
  /** Tenant-scoped runtime directory — the process gets `ARIA_RUNTIME_DIR` set to this. */
  runtimeDir: string;
  /** Directory the per-tenant log file is written into (created if missing). */
  logDir: string;
  /** Extra env vars merged on top of `{ ...process.env, ARIA_RUNTIME_DIR }`. */
  extraEnv?: Record<string, string>;
  /**
   * Substring to watch for on stdout that marks the process as genuinely
   * "running" (not just spawned) — the real engine prints a
   * `"paper engine started"`-prefixed line; the test fixture matches too.
   */
  readyMarker: string;
}

export type TenantProcessEvent =
  | { type: "ready" }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export class TenantProcess {
  readonly clientId: string;
  readonly child: ChildProcess;
  readonly logPath: string;
  private readonly logStream: WriteStream;
  private readyPromiseResolve?: () => void;
  readonly readyPromise: Promise<void>;
  private exited = false;

  private listeners: Array<(event: TenantProcessEvent) => void> = [];

  constructor(opts: TenantProcessSpawnOptions) {
    this.clientId = opts.clientId;
    mkdirSync(opts.logDir, { recursive: true });
    this.logPath = path.join(opts.logDir, `${opts.clientId}.log`);
    this.logStream = createWriteStream(this.logPath, { flags: "a" });

    this.readyPromise = new Promise((resolve) => {
      this.readyPromiseResolve = resolve;
    });

    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, ARIA_RUNTIME_DIR: opts.runtimeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tagLine = (source: "stdout" | "stderr", chunk: Buffer) => {
      this.logStream.write(chunk);
      if (source === "stdout" && !this.readyMarkerSeen && chunk.toString("utf8").includes(opts.readyMarker)) {
        this.readyMarkerSeen = true;
        this.readyPromiseResolve?.();
        this.emit({ type: "ready" });
      }
    };
    this.child.stdout?.on("data", (chunk: Buffer) => tagLine("stdout", chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => tagLine("stderr", chunk));

    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.logStream.end();
      this.emit({ type: "exit", code, signal });
    });
  }

  private readyMarkerSeen = false;

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  onEvent(listener: (event: TenantProcessEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: TenantProcessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Best-effort graceful signal; does not wait for exit — caller decides timeout/escalation policy. */
  signal(sig: NodeJS.Signals): void {
    if (this.exited) return;
    try {
      this.child.kill(sig);
    } catch {
      /* process may have already exited between the check and the call */
    }
  }
}
