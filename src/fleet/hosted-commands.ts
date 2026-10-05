import { FleetCapacityError, FleetShuttingDownError, type FleetManager, type TenantProcessHandle } from "./fleet-manager.js";
import { EngineIdentityError } from "./engine-identity.js";

/** Shared PAPER disclosure used in every user-facing state. */
const PAPER_NOTE = "PAPER mode: simulated, no real orders, no wallet.";

export const UNAVAILABLE_MESSAGE =
  "Hosted PAPER is not available right now. Nothing is wrong with your account; try again later.";

/**
 * Per-user /paper_start throttle (in-memory). A respawn after
 * stopped/crashed/failed is limited to one attempt per `minGapMs` and
 * `maxAttempts` per `windowMs`, so a tester cannot hammer start/stop and
 * stampede the fleet. Idempotent starts (already starting/running) never
 * reach it.
 */
export class StartThrottle {
  private readonly attempts = new Map<number, number[]>();
  constructor(
    private readonly minGapMs = 15_000,
    private readonly maxAttempts = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns ms to wait, or 0 when an attempt is allowed now. */
  waitMs(userId: number): number {
    const t = this.now();
    const recent = (this.attempts.get(userId) ?? []).filter((a) => t - a < this.windowMs);
    // Never keep empty keys: a user who stopped hitting /paper_start must not leak a map entry.
    if (recent.length === 0) this.attempts.delete(userId);
    else this.attempts.set(userId, recent);
    let wait = 0;
    const last = recent[recent.length - 1];
    if (last !== undefined) wait = Math.max(wait, this.minGapMs - (t - last));
    if (recent.length >= this.maxAttempts) wait = Math.max(wait, this.windowMs - (t - recent[0]!));
    return Math.max(0, wait);
  }

  record(userId: number): void {
    const list = this.attempts.get(userId) ?? [];
    list.push(this.now());
    this.attempts.set(userId, list);
    if (this.attempts.size > 256) this.prune();
  }

  /** Drops every user whose attempts are all outside the window (bounded memory without a timer). */
  prune(): void {
    const t = this.now();
    for (const [u, list] of this.attempts) {
      if (list.every((a) => t - a >= this.windowMs)) this.attempts.delete(u);
    }
  }

  size(): number {
    return this.attempts.size;
  }
}

/**
 * Hosted PAPER Engine, Task 4 — the Telegram-facing command logic that
 * wires `/paper_start`, `/paper_stop`, `/paper_status` to the Fleet
 * Manager. Deliberately grammy-free: every dependency (Fleet Manager
 * calls, DB lookups, the outbound DM) is injected via `HostedCommandsDeps`
 * so this module — and the tests in hosted-commands.test.ts — never touch
 * a real `Bot` instance, a real Postgres pool, or a real child process.
 * `bot.ts` is the only place these get wired to the real things.
 */

export interface EngineClientLike {
  id: string;
  hosting_mode: "local" | "hosted";
}

export interface HostedCommandsDeps {
  fleetManager: Pick<FleetManager, "spawnTenant" | "stopTenant" | "getTenantStatus"> &
    Partial<Pick<FleetManager, "getDesiredState">>;
  /** Optional: called after a /paper_start spawn succeeds (clears rehydration give-up bookkeeping). */
  onStarted?: (clientId: string) => void;
  /** Optional: "gave_up" when boot rehydration stopped retrying this tenant (needs attention). */
  rehydrationState?: (clientId: string) => "gave_up" | undefined;
  /** Optional per-user start throttle; when absent no throttling happens. */
  startThrottle?: StartThrottle;
  getLatestActiveClientForUser: (userId: number) => Promise<EngineClientLike | undefined>;
  /** Creates a brand-new hosted-only engine_clients row (device identity + DB insert) — see hosted-device-identity.ts for why a REAL keypair is generated, not a placeholder string. */
  registerHostedClient: (userId: number) => Promise<EngineClientLike>;
  /**
   * Converts an EXISTING client row (one originally paired via the LOCAL
   * `aria pair <code>` flow) to `hosting_mode: "hosted"`.
   *
   * Task 4 REVIEW FIX (2026-09-18): this used to be a bare `setHostingMode`
   * DB-flag flip with no disk write — see the P0 this replaced, documented
   * in full on `rotateClientDeviceIdentity` (engine-clients.ts) and in the
   * ledger's Task 4 Log entry. A row paired locally has a
   * `device_public_key` whose private half never left the user's machine;
   * spawning a hosted tenant for that row into a fresh, empty per-tenant
   * runtime directory would make the real `aria-engine` CLI silently
   * generate an unrelated keypair there, permanently breaking that
   * tenant's `/api/engine/sync` signature verification with no visible
   * error.
   *
   * Task 4 SECOND REVIEW FIX (2026-09-18): the fix above still had a real
   * (if narrower) crash window — it committed the DB changes BEFORE writing
   * the identity to disk, so a crash in between left `hosting_mode` durably
   * "hosted" with no identity file to back it, permanently defeating the
   * `else if (client.hosting_mode !== "hosted")` retry guard in
   * `startHostedEngine`. The real implementation (bot.ts) must now, for the
   * SAME client, in THIS order:
   *   1. generate a fresh Ed25519 keypair via `generateHostedDeviceIdentity()`
   *      (the same helper `registerHostedClient` uses for a brand-new row —
   *      reused, not duplicated);
   *   2. write it to that tenant's runtime directory FIRST (same helper/path
   *      `registerHostedClient` uses) — if this throws (disk full,
   *      permissions), the DB must never be touched;
   *   3. only THEN commit the DB side, as ONE atomic UPDATE
   *      (`rotateClientDeviceIdentityAndSetHosted`, engine-clients.ts) that
   *      rotates `device_public_key` and flips `hosting_mode` to `"hosted"`
   *      together — never as two separate statements, which would
   *      reintroduce an intermediate "rotated but still local" state.
   * This is a deliberate one-way identity rotation for that client_id, not a
   * dual-identity arrangement — see the ledger for why rotating the existing
   * row in place (rather than creating a second row) is the correct model
   * for this product. It is also a DISCLOSED transition: `handlePaperStart`
   * below adds a supersession notice to the success DM specifically for
   * this path (never for a brand-new hosted-only client, which has no
   * prior local identity to supersede).
   */
  convertClientToHosted: (clientId: string) => Promise<void>;
  isUserApproved: (userId: number) => Promise<boolean>;
  /**
   * Sends one DM to the given Telegram user id. `bot.ts`'s implementation
   * wraps `bot.api.sendMessage` in the repo's existing
   * `try { ... } catch { logger.warn(...) }` pattern (matching every
   * `notify*` function already in bot.ts) — that try/catch lives in
   * exactly ONE place (bot.ts's wiring) rather than being duplicated in
   * each handler below, but the CONTRACT every handler relies on is the
   * same one those functions already guarantee: `notify` never throws,
   * so a delivery failure (user never started the bot chat, blocked it,
   * etc.) can never crash a command handler.
   */
  notify: (telegramUserId: number, text: string) => Promise<void>;
  /**
   * Entitlement-renewal fix (2026-09-19) — re-issues that client's ARIAE1
   * entitlement token IN PLACE if it's missing/expired/expiring within
   * `ENTITLEMENT_RENEWAL_MARGIN_SECONDS` (hosted-pairing-seed.ts's
   * `renewHostedPairingStateIfNeeded`), and is a no-op if the existing
   * token is still comfortably valid. Called for EVERY call to
   * `startHostedEngine` below — not just first-time registration/
   * conversion — because `seedHostedPairingState` only ever mints a token
   * ONCE (at create/convert time) with a fixed 7-day TTL; without this,
   * every hosted tenant older than that TTL would permanently fail the
   * entitlement gate on its next `/paper_start` (or FleetManager
   * auto-restart) with no user-facing recovery path. Must be called
   * BEFORE `fleetManager.spawnTenant()` — if it throws, `startHostedEngine`
   * must not proceed to spawn (see that function's try/catch below).
   */
  renewHostedEntitlementIfNeeded: (clientId: string) => Promise<void>;
}

export interface HandlerCtx {
  telegramUserId: number;
  /** Internal numeric `users.id` — already resolved by bot.ts from verified Telegram identity, never trusted from anywhere else. */
  userId: number;
}

export type StartResult =
  | { ok: true; created: boolean; converted: boolean; handle: TenantProcessHandle }
  | { ok: false; reason: "capacity" | "error" | "unavailable" | "throttled" | "shutting_down"; message: string };

/**
 * Core start logic (DB + Fleet Manager only, no Telegram I/O — see
 * `handlePaperStart` below for the command-handler wrapper that adds the
 * approval gate and the DM).
 *
 * Ownership resolution never trusts a client-supplied id: the caller's
 * `userId` (already derived from verified Telegram identity by bot.ts)
 * is the only key ever used to look up or create a client row.
 */
export async function startHostedEngine(deps: HostedCommandsDeps, userId: number): Promise<StartResult> {
  try {
    let client = await deps.getLatestActiveClientForUser(userId);
    // Throttle only applies to a (re)spawn: an already starting/running
    // tenant makes this call an idempotent no-op and is never throttled.
    const existingStatus = client ? deps.fleetManager.getTenantStatus(client.id)?.status : undefined;
    const isRespawn = existingStatus !== "starting" && existingStatus !== "running";
    if (isRespawn && deps.startThrottle) {
      const wait = deps.startThrottle.waitMs(userId);
      if (wait > 0) {
        const secs = Math.ceil(wait / 1000);
        const human = secs >= 90 ? `${Math.ceil(secs / 60)} minutes` : `${secs} seconds`;
        return {
          ok: false,
          reason: "throttled",
          message: `Please wait about ${human} before starting your hosted PAPER engine again. (${PAPER_NOTE})`,
        };
      }
    }
    let created = false;
    let converted = false;
    if (!client) {
      client = await deps.registerHostedClient(userId);
      created = true;
    } else if (client.hosting_mode !== "hosted") {
      await deps.convertClientToHosted(client.id);
      converted = true;
    }
    // Renewal check runs for EVERY call, including the created/converted
    // branches above — a freshly (re)seeded token is nowhere near its 24h
    // renewal margin, so this is a cheap no-op there; for an already-hosted
    // client whose token is missing/expired/expiring soon, this is what
    // actually keeps it working past its original 7-day TTL. Deliberately
    // BEFORE spawnTenant() — a thrown renewal must abort the start, never
    // spawn against a stale/expired token.
    await deps.renewHostedEntitlementIfNeeded(client.id);
    const handle = await deps.fleetManager.spawnTenant(client.id);
    if (isRespawn) deps.startThrottle?.record(userId);
    try {
      deps.onStarted?.(client.id);
    } catch {
      /* bookkeeping hook must never fail a start */
    }
    return { ok: true, created, converted, handle };
  } catch (err) {
    if (err instanceof FleetCapacityError) {
      return {
        ok: false,
        reason: "capacity",
        message: "ARIA's hosted PAPER fleet is at capacity right now — please try again in a few minutes.",
      };
    }
    if (err instanceof EngineIdentityError) {
      return { ok: false, reason: "unavailable", message: UNAVAILABLE_MESSAGE };
    }
    if (err instanceof FleetShuttingDownError) {
      return { ok: false, reason: "shutting_down", message: "ARIA is restarting for an update. Please try again in a minute." };
    }
    // Never leak a raw error/stack trace to the user — a plain-language
    // message only, matching the rest of bot.ts's error-handling style.
    return { ok: false, reason: "error", message: "Could not start your hosted PAPER engine (PAPER mode, simulated) — please try again shortly." };
  }
}

export type StopResult = { ok: true; message: string } | { ok: false; message: string };

export async function stopHostedEngine(deps: HostedCommandsDeps, userId: number, graceful = true): Promise<StopResult> {
  const client = await deps.getLatestActiveClientForUser(userId);
  if (!client) {
    return { ok: false, message: "No hosted engine found for your account yet — use /paper_start first." };
  }
  try {
    await deps.fleetManager.stopTenant(client.id, graceful);
    return { ok: true, message: "Stop requested — your hosted PAPER engine (simulated, no real orders) will shut down shortly." };
  } catch {
    return { ok: false, message: "Could not stop your hosted PAPER engine — please try again shortly." };
  }
}

/**
 * Returns `undefined` when the user has no client at all, OR has a client
 * that was never spawned through the Fleet Manager (`getTenantStatus`
 * returns nothing for a `clientId` it has never tracked) — both cases are
 * genuinely "never started", and `formatHostedStatusMessage` below relies
 * on that undefined meaning exactly that, never conflating it with a real
 * `"stopped"` handle (a tenant that WAS running and was later stopped,
 * which keeps its handle with `status: "stopped"`).
 */
export async function getHostedStatus(deps: HostedCommandsDeps, userId: number): Promise<TenantProcessHandle | undefined> {
  const client = await deps.getLatestActiveClientForUser(userId);
  if (!client) return undefined;
  return deps.fleetManager.getTenantStatus(client.id);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (parts.length === 0 || minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/**
 * Renders the REAL `TenantProcessHandle` fields. `undefined` means literally
 * never started AND no durable desired-state record; `desiredRunning` with no
 * handle means the control plane restarted and the engine is being brought
 * back (rehydration), which is NOT "never started". Internal details (exit
 * codes, restart counts) stay in structured logs, never in user text.
 */
export function formatHostedStatusMessage(handle: TenantProcessHandle | undefined, opts: { desiredRunning?: boolean; gaveUp?: boolean } = {}): string {
  const header = "*Hosted PAPER status*";
  if (!handle) {
    if (opts.desiredRunning && opts.gaveUp) {
      return [
        header,
        "",
        "Status: 🔴 *Needs attention* — your PAPER engine could not be restarted automatically after the service update",
        "Use /paper_start to try again.",
        PAPER_NOTE,
      ].join("\n");
    }
    if (opts.desiredRunning) {
      return [
        header,
        "",
        "Status: 🟡 *Restarting after a service update*",
        "Your PAPER engine will resume automatically; no action needed.",
        PAPER_NOTE,
      ].join("\n");
    }
    return [header, "", "Status: _Never started_", "", "Use /paper_start to launch your hosted PAPER engine — no local install required."].join("\n");
  }

  const lines = [header, ""];
  switch (handle.status) {
    case "starting":
      lines.push("Status: 🟡 *Starting* (PAPER)");
      break;
    case "running":
      lines.push("Status: 🟢 *Running* (PAPER)");
      if (handle.startedAt) {
        lines.push(`Running for: ${formatDuration(Date.now() - new Date(handle.startedAt).getTime())}`);
      }
      break;
    case "stopping":
      lines.push("Status: 🟡 *Stopping* (PAPER)");
      break;
    case "stopped":
      lines.push("Status: ⚪ *Stopped* (PAPER)");
      break;
    case "crashed":
      lines.push("Status: 🔴 *Crashed* — your PAPER engine is retrying automatically");
      break;
    case "failed":
      lines.push("Status: 🔴 *Failed* — your PAPER engine stopped after repeated crashes and gave up retrying");
      lines.push("Use /paper_start to try again.");
      break;
  }
  lines.push("", PAPER_NOTE);
  return lines.join("\n");
}

/** `/paper_start` command logic — approval gate + start + DM. */
export async function handlePaperStart(deps: HostedCommandsDeps, ctx: HandlerCtx): Promise<void> {
  if (!(await deps.isUserApproved(ctx.userId))) {
    await deps.notify(
      ctx.telegramUserId,
      "ARIA is in a controlled first-beta right now — ask the person who told you about it for an invite link.",
    );
    return;
  }
  const result = await startHostedEngine(deps, ctx.userId);
  if (result.ok) {
    const verb = result.created
      ? "Your hosted PAPER engine was just created and is starting"
      : "Your hosted PAPER engine is starting";
    // Problem 2 (Task 4 SECOND REVIEW FIX, 2026-09-18): a `converted` result
    // means this client row was PREVIOUSLY paired via the local `aria pair
    // <code>` CLI flow and is now being one-way rotated to a hosted-only
    // identity (see `convertClientToHosted`'s docblock above). That local
    // pairing's device identity is permanently superseded the moment this
    // DM is sent — the user has no other way to find out, since nothing
    // about the local CLI itself changes or errors until its NEXT sync
    // attempt fails signature verification. Only fires for this specific
    // transition — a brand-new hosted-only client (`created === true`) has
    // no prior local identity to supersede, so no disclosure is needed or
    // shown for it.
    const supersessionNotice = result.converted
      ? " Note: this replaces your existing local device pairing for this account — your local ARIA CLI will stop syncing after this. Run /pair again if you want to use the local CLI."
      : "";
    await deps.notify(
      ctx.telegramUserId,
      `✅ ${verb} — this runs on ARIA's infrastructure, no local process needed. Use /paper_status to check progress.${supersessionNotice}`,
    );
  } else {
    await deps.notify(ctx.telegramUserId, `⚠️ ${result.message}`);
  }
}

/** `/paper_stop` command logic — stop + DM. */
export async function handlePaperStop(deps: HostedCommandsDeps, ctx: HandlerCtx): Promise<void> {
  const result = await stopHostedEngine(deps, ctx.userId);
  await deps.notify(ctx.telegramUserId, `${result.ok ? "🛑" : "⚠️"} ${result.message}`);
}

/** `/paper_status` command logic — status + DM. */
export async function handlePaperStatus(deps: HostedCommandsDeps, ctx: HandlerCtx): Promise<void> {
  const handle = await getHostedStatus(deps, ctx.userId);
  let desiredRunning = false;
  let gaveUp = false;
  if (!handle) {
    try {
      const client = await deps.getLatestActiveClientForUser(ctx.userId);
      desiredRunning = client ? deps.fleetManager.getDesiredState?.(client.id) === "running" : false;
      gaveUp = client ? deps.rehydrationState?.(client.id) === "gave_up" : false;
    } catch {
      desiredRunning = false;
    }
  }
  await deps.notify(ctx.telegramUserId, formatHostedStatusMessage(handle, { desiredRunning, gaveUp }));
}
