import { FleetCapacityError, type FleetManager, type TenantProcessHandle } from "./fleet-manager.js";
import { EngineIdentityError } from "./engine-identity.js";
import { NOOP_LOGGER, type FleetLogger } from "./desired-state.js";

/**
 * Boot-time rehydration of hosted tenants + the periodic approval re-check.
 *
 * WHY: the Fleet Manager's tenant map is memory-only. Before this, any
 * control-plane restart/redeploy silently killed every user's engine. The
 * durable desired-state file (desired-state.ts) records what each user asked
 * for; this module brings every desired=running tenant back, safely:
 *
 *  - never blocks boot or /healthz (callers fire-and-forget `rehydrateTenants`);
 *  - bounded concurrency + a stagger between spawns so a redeploy does not
 *    stampede memory / RPC;
 *  - re-verifies the client row (exists, active, hosted) and that its owner is
 *    still approved BEFORE spawning; otherwise writes desired=stopped;
 *  - runs entitlement renewal BEFORE spawn (an expired token would fail the
 *    engine's own gate);
 *  - capacity-capped tenants stay desired=running and are retried by the
 *    periodic tick until a slot frees; engine-unavailable / transient DB
 *    failures likewise keep desired=running and retry;
 *  - one tenant's failure never aborts the sweep or crashes the process;
 *  - logs once per state change per tenant, not per tick.
 *
 * APPROVAL REVOKE: there is no single clean revoke hook in this codebase
 * (`suspendInviteForUser` has no caller; `/revokeengine` revokes an
 * entitlement, `revokeClient` revokes a device row; `isUserApproved` reads the
 * invites table). So the chosen mechanism is the periodic re-check
 * (`checkApprovals`, default every 5 min): every active tenant's client row +
 * owner approval is re-verified and revoked ones are stopped (which also writes
 * desired=stopped). Transient DB errors never stop a tenant.
 */

export interface RehydrationClientLike {
  id: string;
  user_id: number;
  status: string;
  hosting_mode: string;
}

export interface RehydratorDeps {
  fleet: Pick<
    FleetManager,
    "scanDesiredRunning" | "getDesiredState" | "setDesiredState" | "spawnTenant" | "stopTenant" | "getTenantStatus" | "listActiveTenants" | "isShuttingDown"
  >;
  getClientById: (clientId: string) => Promise<RehydrationClientLike | undefined>;
  isUserApproved: (userId: number) => Promise<boolean>;
  renewHostedEntitlementIfNeeded: (clientId: string) => Promise<void>;
  log?: FleetLogger;
  /** Max tenants being (re)started at once. Default 2. */
  concurrency?: number;
  /** Minimum gap between successive spawn starts. Default 500 ms. */
  staggerMs?: number;
  /** Retry interval for tenants that could not start yet (capacity/engine/DB). Default 60 s. */
  retryIntervalMs?: number;
  /** Approval re-check interval for running tenants. Default 5 min. */
  approvalCheckIntervalMs?: number;
}

export interface RehydrationCounts {
  queued: number;
  restarting: number;
  running: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TenantRehydrator {
  private readonly log: FleetLogger;
  private readonly concurrency: number;
  private readonly staggerMs: number;
  private readonly retryIntervalMs: number;
  private readonly approvalCheckIntervalMs: number;
  /** Tenants waiting for (another) attempt. */
  private readonly pending = new Set<string>();
  /** Tenants this rehydrator has spawned (for counts). */
  private readonly spawned = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Last logged reason per tenant, so a persistent condition logs once, not per tick. */
  private readonly lastReason = new Map<string, string>();
  private sweeping = false;
  private nextStartAt = 0;
  private retryTimer?: NodeJS.Timeout;
  private approvalTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly deps: RehydratorDeps) {
    this.log = deps.log ?? NOOP_LOGGER;
    this.concurrency = Math.max(1, deps.concurrency ?? 2);
    this.staggerMs = deps.staggerMs ?? 500;
    this.retryIntervalMs = deps.retryIntervalMs ?? 60_000;
    this.approvalCheckIntervalMs = deps.approvalCheckIntervalMs ?? 5 * 60_000;
  }

  /** Counts only (no ids, no secrets) for /healthz. */
  counts(): RehydrationCounts {
    let restarting = this.inFlight.size;
    let running = 0;
    for (const id of this.spawned) {
      const st = this.deps.fleet.getTenantStatus(id)?.status;
      if (st === "starting" && !this.inFlight.has(id)) restarting++;
      else if (st === "running") running++;
    }
    return { queued: this.pending.size - this.inFlight.size, restarting, running };
  }

  /** True while this tenant is still waiting to be (re)started by rehydration. */
  isPending(clientId: string): boolean {
    return this.pending.has(clientId) || this.inFlight.has(clientId);
  }

  /** Starts the periodic retry + approval timers (unref'd). */
  startPeriodic(): void {
    if (this.retryTimer || this.approvalTimer) return;
    this.retryTimer = setInterval(() => void this.retryTick(), this.retryIntervalMs);
    this.approvalTimer = setInterval(() => void this.checkApprovals(), this.approvalCheckIntervalMs);
    this.retryTimer.unref();
    this.approvalTimer.unref();
  }

  /** Stops the timers and refuses further work (used on shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.retryTimer = this.approvalTimer = undefined;
  }

  private async retryTick(): Promise<void> {
    if (this.pending.size === 0 || this.sweeping || this.stopped) return;
    await this.runSweep();
  }

  /** One full sweep: scan the volume, queue every desired=running tenant, and work the queue. Never throws. */
  async rehydrateTenants(): Promise<void> {
    if (this.stopped || this.sweeping) return;
    try {
      for (const id of this.deps.fleet.scanDesiredRunning()) {
        const st = this.deps.fleet.getTenantStatus(id)?.status;
        if (st === "starting" || st === "running" || st === "stopping") continue;
        this.pending.add(id);
      }
    } catch (err) {
      this.log.error({ code: (err as NodeJS.ErrnoException)?.code }, "tenant rehydration scan failed");
      return;
    }
    if (this.pending.size > 0) this.log.info({ count: this.pending.size }, "rehydrating hosted PAPER tenants after restart");
    await this.runSweep();
  }

  private async runSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const queue = [...this.pending];
      const worker = async () => {
        for (;;) {
          if (this.stopped || this.deps.fleet.isShuttingDown()) return;
          const id = queue.shift();
          if (id === undefined) return;
          // Stagger: reserve the next start slot synchronously so concurrent workers are spaced out.
          const startAt = Math.max(Date.now(), this.nextStartAt);
          this.nextStartAt = startAt + this.staggerMs;
          const wait = startAt - Date.now();
          if (wait > 0) await sleep(wait);
          this.inFlight.add(id);
          try {
            await this.processOne(id);
          } catch (err) {
            // Belt and braces: processOne handles its own errors; this keeps a bug from killing the sweep.
            this.noteOnce(id, "unexpected", "warn", "tenant rehydration hit an unexpected error; will retry", err);
          } finally {
            this.inFlight.delete(id);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, () => worker()));
    } finally {
      this.sweeping = false;
    }
  }

  private noteOnce(id: string, reason: string, level: "info" | "warn", msg: string, err?: unknown): void {
    if (this.lastReason.get(id) === reason) return;
    this.lastReason.set(id, reason);
    const fields: Record<string, unknown> = { clientId: id, reason };
    if (err) fields.errName = (err as Error)?.name;
    this.log[level](fields, msg);
  }

  private async processOne(id: string): Promise<void> {
    const { fleet } = this.deps;
    // Re-read: the user may have /paper_stop'ed (or restarted) while this was queued.
    if (fleet.getDesiredState(id) !== "running") {
      this.pending.delete(id);
      return;
    }
    const st = fleet.getTenantStatus(id)?.status;
    if (st === "starting" || st === "running") {
      this.pending.delete(id);
      return;
    }

    let client: RehydrationClientLike | undefined;
    let approved: boolean;
    try {
      client = await this.deps.getClientById(id);
      approved = client ? await this.deps.isUserApproved(client.user_id) : false;
    } catch (err) {
      this.noteOnce(id, "db-unavailable", "warn", "rehydration could not verify client/approval; keeping desired=running and retrying", err);
      return; // stays pending
    }
    if (!client || client.status !== "active" || client.hosting_mode !== "hosted" || !approved) {
      const why = !client ? "client-missing" : client.status !== "active" ? "client-inactive" : client.hosting_mode !== "hosted" ? "not-hosted" : "not-approved";
      this.markStopped(id, why);
      return;
    }

    try {
      await this.deps.renewHostedEntitlementIfNeeded(id);
    } catch (err) {
      this.noteOnce(id, "renewal-failed", "warn", "entitlement renewal failed before rehydration spawn; keeping desired=running and retrying", err);
      return;
    }

    try {
      await fleet.spawnTenant(id);
    } catch (err) {
      if (err instanceof FleetCapacityError) {
        this.noteOnce(id, "capacity", "info", "fleet at capacity; tenant stays queued (desired=running) until a slot frees");
      } else if (err instanceof EngineIdentityError) {
        this.noteOnce(id, "engine-unavailable", "warn", "engine unavailable/unverified; tenant stays desired=running and will be retried");
      } else {
        this.noteOnce(id, "spawn-failed", "warn", "rehydration spawn failed; will retry", err);
      }
      return;
    }
    this.pending.delete(id);
    this.spawned.add(id);
    this.lastReason.delete(id);
    this.log.info({ clientId: id }, "hosted PAPER tenant rehydrated");
  }

  private markStopped(id: string, why: string): void {
    this.pending.delete(id);
    try {
      this.deps.fleet.setDesiredState(id, "stopped");
    } catch (err) {
      this.log.error({ clientId: id, code: (err as NodeJS.ErrnoException)?.code }, "could not persist desired=stopped during rehydration");
    }
    this.log.info({ clientId: id, reason: why }, "tenant not rehydrated; desired state set to stopped");
  }

  /**
   * Periodic approval re-check for tenants that are running (or starting):
   * stops any whose client row is gone/revoked/not hosted or whose owner is
   * no longer approved. Transient lookup errors are skipped, never acted on.
   */
  async checkApprovals(): Promise<void> {
    if (this.stopped || this.deps.fleet.isShuttingDown()) return;
    let active: TenantProcessHandle[];
    try {
      active = this.deps.fleet.listActiveTenants().filter((h) => h.status === "starting" || h.status === "running");
    } catch {
      return;
    }
    for (const h of active) {
      try {
        const client = await this.deps.getClientById(h.clientId);
        const approved = client ? await this.deps.isUserApproved(client.user_id) : false;
        if (client && client.status === "active" && client.hosting_mode === "hosted" && approved) continue;
        this.log.info({ clientId: h.clientId, reason: !client ? "client-missing" : !approved ? "not-approved" : "client-inactive" }, "approval revoked; stopping hosted PAPER tenant");
        await this.deps.fleet.stopTenant(h.clientId, true); // writes desired=stopped first
      } catch (err) {
        this.log.warn({ clientId: h.clientId, errName: (err as Error)?.name }, "approval re-check failed for a tenant; leaving it as is");
      }
    }
  }
}
