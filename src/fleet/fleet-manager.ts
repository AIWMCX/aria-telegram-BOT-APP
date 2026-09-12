import path from "node:path";
import { TenantProcess } from "./tenant-process.js";

/**
 * Fleet Manager core — Task 2 of the hosted-PAPER-engine program. Spawns,
 * monitors, and stops one `aria-engine` CLI child process per hosted
 * tenant. See docs/superpowers/specs/2026-09-08-hosted-engine-design.md
 * and the plan's Task 2 section for the full contract this implements.
 *
 * Scope boundary (per the plan's Global Constraints): this class only
 * starts/stops the CLI process and watches its stdout/exit code. It never
 * reads or writes aria-engine internals, never touches wallet/signing
 * anything, and never spawns anything other than the configured engine
 * command (`paper start` / `paper stop`).
 */

export interface TenantProcessHandle {
  clientId: string;
  status: "starting" | "running" | "stopping" | "stopped" | "crashed";
  pid?: number;
  startedAt?: string;
  lastExitCode?: number | null;
  restartCount: number;
}

/** How to invoke the engine CLI for one tenant action. Injectable so tests can point at the fake fixture instead of the real binary. */
export interface EngineInvocation {
  buildStart(): { command: string; args: string[]; cwd: string };
  buildStop(): { command: string; args: string[]; cwd: string };
  /** Substring on stdout that marks a just-started process as genuinely running. */
  readyMarker: string;
}

/** Default invocation: run the real aria-engine CLI via tsx, unmodified, from the sibling checkout. */
export function realEngineInvocation(engineRepoPath: string): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "paper", "start"], cwd: engineRepoPath }),
    buildStop: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "paper", "stop"], cwd: engineRepoPath }),
    readyMarker: "paper engine started",
  };
}

export interface FleetManagerOptions {
  /** How to invoke the engine for start/stop. Defaults to the real CLI if `engineRepoPath` is given. */
  engineInvocation: EngineInvocation;
  /** Root directory under which each tenant gets `<tenantsRoot>/<clientId>/.aria`. Design spec: `/data/tenants/<client_id>/.aria` on the Railway volume. */
  tenantsRoot: string;
  /** Root directory for per-tenant log files (never mixed with another tenant's or the Fleet Manager's own stdout). */
  logsRoot: string;
  /**
   * Fixed restart backoff for v1 (documented, not tunable yet — Task 3
   * builds the fuller crash-loop-protection policy, e.g. exponential
   * backoff + a max-restarts-per-window cap, on top of this). 5 seconds
   * is long enough that a crash-looping tenant doesn't hot-loop the CPU
   * or spam its own log file, short enough that a transient blip (e.g. a
   * momentary RPC hiccup causing a nonzero exit) recovers quickly for the
   * user waiting on it.
   */
  restartBackoffMs?: number;
  /** How long a graceful stop (via `paper stop`'s desired-state file) is given to converge before falling back to SIGTERM, and SIGTERM to SIGKILL. Defaults below. */
  gracefulStopTimeoutMs?: number;
  sigtermTimeoutMs?: number;
}

interface TenantEntry {
  handle: TenantProcessHandle;
  process?: TenantProcess;
  restartTimer?: NodeJS.Timeout;
  /** Set while a stopTenant() call is actively driving this tenant to a stop, so a racing spawnTenant/stopTenant call can see intent instead of stale status. */
  stopInFlight?: Promise<void>;
}

const DEFAULT_RESTART_BACKOFF_MS = 5000;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 8000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 4000;

export class FleetManager {
  private readonly tenants = new Map<string, TenantEntry>();
  private readonly opts: Required<FleetManagerOptions>;

  constructor(opts: FleetManagerOptions) {
    this.opts = {
      restartBackoffMs: DEFAULT_RESTART_BACKOFF_MS,
      gracefulStopTimeoutMs: DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
      sigtermTimeoutMs: DEFAULT_SIGTERM_TIMEOUT_MS,
      ...opts,
    };
  }

  private runtimeDirFor(clientId: string): string {
    return path.join(this.opts.tenantsRoot, clientId, ".aria");
  }

  /**
   * Spawning an already-running (`starting`/`running`) tenant is a NO-OP
   * that returns the existing handle, not a rejection. Rationale: the
   * caller (Task 4's Telegram command handler) is expected to call this
   * from a "user tapped Start" intent, which can legitimately race a
   * double-tap or a retried webhook — treating that as an error would
   * force every caller to pre-check `getTenantStatus` first for no
   * benefit. A tenant mid-`stopping` is different: that's an active
   * transition the caller just asked for, so a spawn during it IS
   * rejected (the caller must wait for the stop to finish before
   * restarting) to avoid a spawn racing a not-yet-released lock file.
   */
  async spawnTenant(clientId: string): Promise<TenantProcessHandle> {
    const existing = this.tenants.get(clientId);
    if (existing) {
      if (existing.handle.status === "starting" || existing.handle.status === "running") {
        return existing.handle;
      }
      if (existing.handle.status === "stopping") {
        throw new Error(`tenant ${clientId} is currently stopping — wait for it to finish before starting again`);
      }
      // stopped/crashed: fall through and respawn, reusing the same handle object (restartCount persists).
      // If a restart was already scheduled from the crash (status "crashed"
      // with a pending restartTimer), cancel it here before proceeding —
      // otherwise the OLD timer stays armed with a stale closure. Its own
      // `status !== "crashed"` guard prevents it from spawning a SECOND
      // live process once this explicit launch() flips status away from
      // "crashed", but if the newly-spawned process itself crashes again
      // before the old timer's backoff elapses, status flips back to
      // "crashed" and the old timer's guard would pass, firing an
      // unwanted extra (premature) restart on top of the new crash's own
      // correctly-scheduled timer. Clearing it here removes that
      // dangling reference entirely instead of relying on the guard.
      if (existing.restartTimer) {
        clearTimeout(existing.restartTimer);
        existing.restartTimer = undefined;
      }
    }

    const entry: TenantEntry = existing ?? {
      handle: { clientId, status: "starting", restartCount: 0 },
    };
    this.tenants.set(clientId, entry);
    this.launch(entry, /* isRestart */ false);
    return entry.handle;
  }

  private launch(entry: TenantEntry, isRestart: boolean): void {
    const clientId = entry.handle.clientId;
    const runtimeDir = this.runtimeDirFor(clientId);
    const { command, args, cwd } = this.opts.engineInvocation.buildStart();

    entry.handle.status = "starting";
    entry.handle.startedAt = new Date().toISOString();
    if (isRestart) entry.handle.restartCount += 1;

    const tp = new TenantProcess({
      clientId,
      command,
      args,
      cwd,
      runtimeDir,
      logDir: this.opts.logsRoot,
      readyMarker: this.opts.engineInvocation.readyMarker,
    });
    entry.process = tp;
    entry.handle.pid = tp.pid;

    tp.onEvent((event) => {
      if (event.type === "ready") {
        if (entry.handle.status === "starting") entry.handle.status = "running";
        return;
      }
      // exit
      entry.handle.lastExitCode = event.code;
      const wasStopping = entry.handle.status === "stopping";
      entry.process = undefined;
      entry.handle.pid = undefined;

      if (wasStopping) {
        entry.handle.status = "stopped";
        return;
      }

      // Unexpected exit: crash + backoff restart, per the documented fixed policy.
      entry.handle.status = "crashed";
      entry.restartTimer = setTimeout(() => {
        // Guard: if stopTenant() was called while we were waiting to
        // restart (status may have moved to "stopping"/"stopped"
        // between schedule and fire), don't resurrect it.
        if (entry.handle.status !== "crashed") return;
        this.launch(entry, /* isRestart */ true);
      }, this.opts.restartBackoffMs);
    });
  }

  /**
   * `stopTenant` for a `clientId` with no tracked entry (or one already
   * `stopped`) is a safe no-op — there is nothing to stop, and callers
   * (e.g. a Telegram "Stop" tap after the process already exited on its
   * own) should not have to special-case that.
   *
   * The REAL stop mechanism, per investigation of aria-engine's
   * `cmdPaperControl`/`readDesiredState` (cli.ts): `aria paper stop` does
   * NOT signal the running process directly. It writes a "desired state"
   * file under the SAME `ARIA_RUNTIME_DIR` the running process polls
   * (every tick, ~5s) and returns immediately — the actual shutdown is
   * asynchronous and cooperative. So a correct `stopTenant`:
   *   1. Runs the engine's own `paper stop` (as a short-lived separate
   *      invocation, same ARIA_RUNTIME_DIR) so the desired-state file is
   *      the one FIRST-CHOICE mechanism used — this lets the child persist
   *      its snapshot/state and release its lock file cleanly, exactly as
   *      a local operator's `aria paper stop` would.
   *   2. Waits (bounded by `gracefulStopTimeoutMs`) for the CHILD PROCESS
   *      itself to actually exit — not just for the control command to
   *      return, since that returning tells us nothing about whether the
   *      polling loop has noticed yet.
   *   3. If it hasn't converged in time, escalates to SIGTERM and waits
   *      `sigtermTimeoutMs`.
   *   4. If it STILL hasn't exited, SIGKILL — supervised-kill fallback,
   *      never left indefinitely stuck in "stopping".
   * `graceful=false` skips straight to step 3 (SIGTERM then SIGKILL) —
   * used for admin/force-stop paths that don't want to wait out the
   * cooperative desired-state cycle.
   */
  async stopTenant(clientId: string, graceful: boolean): Promise<void> {
    const entry = this.tenants.get(clientId);
    if (!entry || entry.handle.status === "stopped") return;
    if (entry.stopInFlight) return entry.stopInFlight;

    if (!entry.process) {
      // No live process to signal — this is the "crashed" state with a
      // restart pending (entry.restartTimer set), or some other no-process
      // state. The ORIGINAL BUG: this branch used to be folded into the
      // early-return guard above (`!entry.process` triggered a silent
      // no-op), so calling stopTenant() during the crash/pending-restart
      // window returned as if the stop succeeded while restartTimer stayed
      // armed and fired anyway, resurrecting a process the caller had just
      // asked to stop. Fix: cancel the pending restart and transition to
      // "stopped" for real instead of no-op'ing.
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = undefined;
      }
      entry.handle.status = "stopped";
      return;
    }

    const tp = entry.process;
    entry.handle.status = "stopping";
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }

    const exitPromise = new Promise<void>((resolve) => {
      tp.onEvent((event) => {
        if (event.type === "exit") resolve();
      });
      if (tp.hasExited) resolve();
    });

    const withTimeout = (p: Promise<void>, ms: number) =>
      Promise.race([
        p.then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);

    const run = async () => {
      if (graceful) {
        try {
          const { command, args, cwd } = this.opts.engineInvocation.buildStop();
          const { spawn } = await import("node:child_process");
          const runtimeDir = this.runtimeDirFor(clientId);
          await new Promise<void>((resolve) => {
            const ctrl = spawn(command, args, {
              cwd,
              env: { ...process.env, ARIA_RUNTIME_DIR: runtimeDir },
              stdio: "ignore",
            });
            ctrl.once("exit", () => resolve());
            ctrl.once("error", () => resolve());
          });
        } catch {
          // fall through to signal-based escalation regardless
        }
        if (await withTimeout(exitPromise, this.opts.gracefulStopTimeoutMs)) return;
      }

      tp.signal("SIGTERM");
      if (await withTimeout(exitPromise, this.opts.sigtermTimeoutMs)) return;

      tp.signal("SIGKILL");
      await exitPromise;
    };

    entry.stopInFlight = run().finally(() => {
      entry.stopInFlight = undefined;
    });
    return entry.stopInFlight;
  }

  getTenantStatus(clientId: string): TenantProcessHandle | undefined {
    return this.tenants.get(clientId)?.handle;
  }

  listActiveTenants(): TenantProcessHandle[] {
    return [...this.tenants.values()]
      .map((e) => e.handle)
      .filter((h) => h.status === "starting" || h.status === "running" || h.status === "stopping");
  }
}
