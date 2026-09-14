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
  /**
   * "crashed" is a TRANSIENT state: the process exited unexpectedly and an
   * auto-restart is scheduled (see the crash-loop backoff policy below).
   * "failed" is TERMINAL: the tenant crashed `maxConsecutiveCrashes` times
   * in a row without a sustained-healthy run in between, so the Fleet
   * Manager has given up auto-restarting it and it now needs a human (or
   * an explicit `spawnTenant()` call — see the runbook) to try again.
   * Splitting these matters for the Telegram status command (Task 4): a
   * paired user should see "crashed, retrying" differently from "failed,
   * needs a fresh start" rather than one status silently covering a
   * loop-forever case and a give-up case.
   */
  status: "starting" | "running" | "stopping" | "stopped" | "crashed" | "failed";
  pid?: number;
  startedAt?: string;
  lastExitCode?: number | null;
  restartCount: number;
  /**
   * Consecutive crashes since the last sustained-healthy run (or since the
   * last manual `spawnTenant()` reset it to 0). Exposed on the handle so a
   * status surface can show "crashed 3/5, retrying in Ns" instead of a
   * bare boolean.
   */
  consecutiveCrashes: number;
}

/** Thrown by `spawnTenant()` when the fleet is already at `maxConcurrentTenants`. Typed so callers (Task 4's Telegram handler) can distinguish "at capacity" from other spawn failures and show a clear message instead of a generic error. */
export class FleetCapacityError extends Error {
  constructor(
    readonly clientId: string,
    readonly limit: number,
  ) {
    super(`fleet is at capacity (${limit} concurrent tenants) — cannot spawn tenant ${clientId}`);
    this.name = "FleetCapacityError";
  }
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
   * BASE restart backoff (Task 3's exponential crash-loop policy, replacing
   * Task 2's fixed 5000ms). The delay before the Nth consecutive auto-restart
   * is `min(restartBackoffMs * 2^(N-1), maxRestartBackoffMs)` — 5s, 10s,
   * 20s, 40s, ... capped at `maxRestartBackoffMs`. 5 seconds as the base is
   * long enough that a crash-looping tenant doesn't hot-loop the CPU or
   * spam its own log file, short enough that a transient blip (e.g. a
   * momentary RPC hiccup causing a nonzero exit) recovers quickly for the
   * user waiting on it.
   */
  restartBackoffMs?: number;
  /**
   * Ceiling on the exponential backoff — default 5 minutes. Past this, a
   * tenant that keeps crashing every ~5 minutes forever would otherwise see
   * the delay grow unbounded; capping it means an operator (or the user
   * retrying via Telegram) doesn't have to wait arbitrarily long between
   * attempts even in a persistent-failure scenario, while `maxConsecutiveCrashes`
   * below is what actually stops the loop.
   */
  maxRestartBackoffMs?: number;
  /**
   * How long a restarted tenant must stay `running` before a SUBSEQUENT
   * crash is treated as a fresh problem (resetting `consecutiveCrashes` to
   * 0) rather than a continuation of the same crash loop (which keeps
   * escalating the backoff). Default 60000ms (60s): long enough that a
   * process which merely restarted and immediately crashed again isn't
   * mistaken for "healthy", short enough that a tenant which genuinely
   * recovered and ran fine for a full minute isn't unfairly penalized by
   * an unrelated crash hours later.
   */
  sustainedHealthyMs?: number;
  /**
   * After this many CONSECUTIVE crashes (without an intervening sustained-
   * healthy run), the Fleet Manager stops auto-restarting and transitions
   * the tenant to the terminal `"failed"` status instead of scheduling
   * another restart. Default 5 — matches the plan's own "give up after N
   * failures" acceptance criterion; low enough that a genuinely broken
   * tenant (bad config, permanently unreachable RPC) doesn't restart-loop
   * indefinitely and rack up log/CPU churn, high enough that ordinary
   * transient blips (a few bad RPC hiccups in a row) still self-heal
   * without needing a human.
   */
  maxConsecutiveCrashes?: number;
  /** How long a graceful stop (via `paper stop`'s desired-state file) is given to converge before falling back to SIGTERM, and SIGTERM to SIGKILL. Defaults below. */
  gracefulStopTimeoutMs?: number;
  sigtermTimeoutMs?: number;
  /**
   * Maximum number of tenants allowed in `starting`/`running`/`stopping`
   * status at once. `spawnTenant()` REJECTS (throws `FleetCapacityError`)
   * once this many slots are occupied, rather than silently dropping or
   * queuing the request. Default 5, matching the plan's own starting-point
   * language ("MAX_HOSTED_USERS=3 or 5") for the first cohort — this is
   * the PRIMARY defense against resource exhaustion in this runtime (see
   * `docs/FLEET_MANAGER_RUNBOOK.md`'s "Resource-limit mechanism" section
   * for why there is no per-process OS-level hard cap available here to
   * rely on instead).
   */
  maxConcurrentTenants?: number;
}

interface TenantEntry {
  handle: TenantProcessHandle;
  process?: TenantProcess;
  restartTimer?: NodeJS.Timeout;
  /** Set while a stopTenant() call is actively driving this tenant to a stop, so a racing spawnTenant/stopTenant call can see intent instead of stale status. */
  stopInFlight?: Promise<void>;
  /** Timestamp (ms, `Date.now()`) this tenant last became `running`. Used to decide whether a subsequent crash counts as a fresh problem (sustained-healthy reset) or a continuation of the same crash loop. `undefined` when not currently/previously running since the last (re)start. */
  runningSince?: number;
}

const DEFAULT_RESTART_BACKOFF_MS = 5000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_SUSTAINED_HEALTHY_MS = 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 5;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 8000;
const DEFAULT_SIGTERM_TIMEOUT_MS = 4000;
const DEFAULT_MAX_CONCURRENT_TENANTS = 5;

export class FleetManager {
  private readonly tenants = new Map<string, TenantEntry>();
  private readonly opts: Required<FleetManagerOptions>;

  constructor(opts: FleetManagerOptions) {
    this.opts = {
      restartBackoffMs: DEFAULT_RESTART_BACKOFF_MS,
      maxRestartBackoffMs: DEFAULT_MAX_RESTART_BACKOFF_MS,
      sustainedHealthyMs: DEFAULT_SUSTAINED_HEALTHY_MS,
      maxConsecutiveCrashes: DEFAULT_MAX_CONSECUTIVE_CRASHES,
      gracefulStopTimeoutMs: DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
      sigtermTimeoutMs: DEFAULT_SIGTERM_TIMEOUT_MS,
      maxConcurrentTenants: DEFAULT_MAX_CONCURRENT_TENANTS,
      ...opts,
    };
  }

  /** Count of tenants currently occupying a process slot (starting/running/stopping — a "stopping" tenant still holds a live OS process until it actually exits). */
  private activeSlotCount(): number {
    let n = 0;
    for (const entry of this.tenants.values()) {
      const s = entry.handle.status;
      if (s === "starting" || s === "running" || s === "stopping") n++;
    }
    return n;
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
      // stopped/crashed/failed: fall through and respawn, reusing the same
      // handle object (restartCount persists). If a restart was already
      // scheduled from the crash (status "crashed" with a pending
      // restartTimer), cancel it here before proceeding — otherwise the
      // OLD timer stays armed with a stale closure. Its own
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
      // A manual spawnTenant() call — whether re-tapping "Start" after a
      // clean stop, or explicitly retrying a "failed" (given-up) tenant
      // per the runbook's documented manual-intervention path — is a
      // FRESH attempt, not a continuation of any prior crash loop. Reset
      // the crash-loop bookkeeping so this new attempt gets the full
      // `maxConsecutiveCrashes` budget and the base backoff, rather than
      // inheriting an escalated backoff/near-give-up state from before.
      existing.handle.consecutiveCrashes = 0;
      existing.runningSince = undefined;
    }

    // Resource bound (Task 3, primary defense per the runbook): reject a
    // spawn that would exceed maxConcurrentTenants rather than silently
    // dropping it or queuing it. Only reached here — never for the
    // starting/running no-op or the stopping rejection above — because
    // those paths don't consume a NEW slot (a tenant already occupying
    // one, or one whose slot is still being released, isn't asking for a
    // fresh slot). A tenant already tracked but currently stopped/crashed/
    // failed does NOT count toward activeSlotCount(), so respawning it is
    // correctly gated by the same capacity check as a brand-new clientId.
    if (this.activeSlotCount() >= this.opts.maxConcurrentTenants) {
      throw new FleetCapacityError(clientId, this.opts.maxConcurrentTenants);
    }

    const entry: TenantEntry = existing ?? {
      handle: { clientId, status: "starting", restartCount: 0, consecutiveCrashes: 0 },
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
        entry.runningSince = Date.now();
        return;
      }
      // exit
      entry.handle.lastExitCode = event.code;
      const wasStopping = entry.handle.status === "stopping";
      entry.process = undefined;
      entry.handle.pid = undefined;

      if (wasStopping) {
        entry.handle.status = "stopped";
        entry.runningSince = undefined;
        return;
      }

      // Unexpected exit: crash-loop bookkeeping (Task 3 — replaces Task 2's
      // fixed 5000ms with exponential backoff + a give-up threshold).
      //
      // Reset condition: if this run stayed `running` for at least
      // `sustainedHealthyMs`, treat this crash as a NEW problem, not a
      // continuation of a prior loop — reset consecutiveCrashes to 0
      // before counting this one, so the backoff starts over at the base
      // delay and the give-up counter doesn't carry a grudge from an
      // unrelated crash long ago.
      const ranHealthyMs = entry.runningSince !== undefined ? Date.now() - entry.runningSince : 0;
      entry.runningSince = undefined;
      if (ranHealthyMs >= this.opts.sustainedHealthyMs) {
        entry.handle.consecutiveCrashes = 0;
      }
      entry.handle.consecutiveCrashes += 1;
      entry.handle.status = "crashed";

      if (entry.handle.consecutiveCrashes >= this.opts.maxConsecutiveCrashes) {
        // Give-up threshold reached: stop auto-restarting entirely and
        // surface a terminal, honest status instead of looping forever.
        // No restartTimer is scheduled — a human (or an explicit
        // spawnTenant() call, per the runbook's manual-intervention path)
        // is now required to try again.
        entry.handle.status = "failed";
        entry.restartTimer = undefined;
        return;
      }

      // Exponential backoff: base * 2^(consecutiveCrashes - 1), capped.
      const backoffMs = Math.min(
        this.opts.restartBackoffMs * 2 ** (entry.handle.consecutiveCrashes - 1),
        this.opts.maxRestartBackoffMs,
      );
      entry.restartTimer = setTimeout(() => {
        // Guard: if stopTenant() was called while we were waiting to
        // restart (status may have moved to "stopping"/"stopped"
        // between schedule and fire), don't resurrect it.
        if (entry.handle.status !== "crashed") return;
        this.launch(entry, /* isRestart */ true);
      }, backoffMs);
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
    // "stopped" and "failed" are both terminal, process-less states with no
    // pending restartTimer (a "failed" tenant gave up auto-restarting by
    // definition — see launch()'s exit handler — so there is nothing armed
    // to cancel here, unlike the "crashed, restart pending" case handled
    // by the `!entry.process` branch below). Leaving a "failed" tenant's
    // status as "failed" (rather than flipping it to "stopped") preserves
    // the honest signal that it gave up due to repeated crashes, not a
    // deliberate stop — an operator or Task 4's status command should
    // still be able to tell the two apart after the fact.
    if (!entry || entry.handle.status === "stopped" || entry.handle.status === "failed") return;
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
