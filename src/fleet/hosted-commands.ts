import { FleetCapacityError, type FleetManager, type TenantProcessHandle } from "./fleet-manager.js";

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
  fleetManager: Pick<FleetManager, "spawnTenant" | "stopTenant" | "getTenantStatus">;
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
   * error. The real implementation (bot.ts) must, for the SAME client:
   *   1. generate a fresh Ed25519 keypair via `generateHostedDeviceIdentity()`
   *      (the same helper `registerHostedClient` uses for a brand-new row —
   *      reused, not duplicated);
   *   2. write it to that tenant's runtime directory (same helper/path
   *      `registerHostedClient` uses);
   *   3. update THIS row's `device_public_key` to match (via
   *      `rotateClientDeviceIdentity`) and flip `hosting_mode` to `"hosted"`.
   * This is a deliberate one-way identity rotation for that client_id, not a
   * dual-identity arrangement — see the ledger for why rotating the existing
   * row in place (rather than creating a second row) is the correct model
   * for this product.
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
}

export interface HandlerCtx {
  telegramUserId: number;
  /** Internal numeric `users.id` — already resolved by bot.ts from verified Telegram identity, never trusted from anywhere else. */
  userId: number;
}

export type StartResult =
  | { ok: true; created: boolean; handle: TenantProcessHandle }
  | { ok: false; reason: "capacity" | "error"; message: string };

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
    let created = false;
    if (!client) {
      client = await deps.registerHostedClient(userId);
      created = true;
    } else if (client.hosting_mode !== "hosted") {
      await deps.convertClientToHosted(client.id);
    }
    const handle = await deps.fleetManager.spawnTenant(client.id);
    return { ok: true, created, handle };
  } catch (err) {
    if (err instanceof FleetCapacityError) {
      return {
        ok: false,
        reason: "capacity",
        message: "ARIA's hosted PAPER fleet is at capacity right now — please try again in a few minutes.",
      };
    }
    // Never leak a raw error/stack trace to the user — a plain-language
    // message only, matching the rest of bot.ts's error-handling style.
    return { ok: false, reason: "error", message: "Could not start your hosted PAPER engine — please try again shortly." };
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
    return { ok: true, message: "Stop requested — your hosted PAPER engine will shut down shortly." };
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
 * Renders the REAL `TenantProcessHandle` fields — never a fabricated "all
 * good" if the real state is degraded (crashed/failed), and never an "OFF"
 * state indistinguishable from "started then stopped": `undefined` means
 * literally never started, `status: "stopped"` means it was running and
 * was stopped (deliberately or via a completed graceful shutdown).
 */
export function formatHostedStatusMessage(handle: TenantProcessHandle | undefined): string {
  const header = "*Hosted PAPER status*";
  if (!handle) {
    return [header, "", "Status: _Never started_", "", "Use /paper_start to launch your hosted PAPER engine — no local install required."].join("\n");
  }

  const lines = [header, ""];
  switch (handle.status) {
    case "starting":
      lines.push("Status: 🟡 *Starting*");
      break;
    case "running":
      lines.push("Status: 🟢 *Running*");
      if (handle.startedAt) {
        lines.push(`Running for: ${formatDuration(Date.now() - new Date(handle.startedAt).getTime())}`);
      }
      break;
    case "stopping":
      lines.push("Status: 🟡 *Stopping*");
      break;
    case "stopped":
      lines.push("Status: ⚪ *Stopped*");
      break;
    case "crashed":
      lines.push(`Status: 🔴 *Crashed* — retrying automatically (${handle.consecutiveCrashes} consecutive)`);
      if (handle.lastExitCode !== null && handle.lastExitCode !== undefined) lines.push(`Last exit code: ${handle.lastExitCode}`);
      break;
    case "failed":
      lines.push(`Status: 🔴 *Failed* — gave up retrying after ${handle.consecutiveCrashes} consecutive crashes`);
      if (handle.lastExitCode !== null && handle.lastExitCode !== undefined) lines.push(`Last exit code: ${handle.lastExitCode}`);
      lines.push("Use /paper_start to try again.");
      break;
  }
  lines.push("", `Total restarts: ${handle.restartCount}`);
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
    await deps.notify(
      ctx.telegramUserId,
      `✅ ${verb} — this runs on ARIA's infrastructure, no local process needed. Use /paper_status to check progress.`,
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
  await deps.notify(ctx.telegramUserId, formatHostedStatusMessage(handle));
}
