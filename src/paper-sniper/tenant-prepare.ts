import { existsSync } from "node:fs";
import path from "node:path";
import { reconcileTenantSniperSync, type SniperSeedResult } from "../fleet/tenant-sniper-seed.js";
import { isSniperUserAllowed, type PaperSniperFlags } from "./config.js";

/** The engine tree must contain the PR D paper sniper (selected by market.kind=real-discovery + discovery.source=file-tail). */
export const SNIPER_ENGINE_MARKERS: readonly string[] = [
  path.join("src", "paper", "sniper", "sniper-runner.ts"),
  path.join("src", "paper", "sniper", "kill-switch.ts"),
];

export function engineSupportsPaperSniper(enginePath: string): boolean {
  return SNIPER_ENGINE_MARKERS.every((m) => existsSync(path.join(enginePath, m)));
}

export interface SniperPrepareDeps {
  flags: PaperSniperFlags;
  /** The shared discovery is enabled AND the packaged engine supports it. */
  discoveryUsable: () => boolean;
  engineHasSniper: () => boolean;
  feedPath: string;
  /** Telegram id of the tenant's owner. undefined = no such client/user. May throw (transient DB error). */
  ownerTelegramId: (clientId: string) => Promise<string | number | undefined>;
  log?: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
}

/** Why the sniper cannot work right now, or undefined when it can. Never contains a value. */
export function sniperUnavailableReason(d: Pick<SniperPrepareDeps, "flags" | "discoveryUsable" | "engineHasSniper">, fleetEnabled: boolean): string | undefined {
  if (!d.flags.enabled) return "PAPER_SNIPER_ENABLED is not true";
  if (!fleetEnabled) return "FLEET_ENABLED is not true";
  if (!d.discoveryUsable()) return "shared discovery is not enabled (DISCOVERY_ENABLED / ARIA_STREAM_* / engine support)";
  if (!d.engineHasSniper()) return "packaged engine does not contain the paper sniper (bump ARIA_ENGINE_COMMIT_SHA)";
  return undefined;
}

/**
 * Pre-spawn hook step (runs AFTER the discovery seed). Seeds the sniper config
 * for an allowed owner when everything is usable; otherwise reverts only what
 * a previous seed set (a tenant that was never seeded is not touched).
 */
export function createSniperTenantPreparer(d: SniperPrepareDeps) {
  const seeded = new Set<string>();
  return {
    /** Number of tenants this process has seeded/confirmed for the sniper since boot. */
    seededCount: () => seeded.size,
    /** True when the last prepare() left this tenant seeded for the sniper (used to decide RPC relay seeding). */
    isSeeded: (clientId: string) => seeded.has(clientId),
    async prepare(clientId: string, runtimeDir: string): Promise<SniperSeedResult | "skipped"> {
      let want = d.flags.enabled && d.discoveryUsable() && d.engineHasSniper();
      if (want) {
        let owner: string | number | undefined;
        try { owner = await d.ownerTelegramId(clientId); } catch {
          d.log?.warn({}, "paper sniper: owner lookup failed; tenant config left as is");
          return "skipped"; // transient: neither seed nor revert
        }
        want = isSniperUserAllowed(d.flags, owner);
      }
      const result = reconcileTenantSniperSync({ runtimeDir, feedPath: d.feedPath, enabled: want });
      if (want && (result === "enabled" || result === "unchanged")) seeded.add(clientId);
      else seeded.delete(clientId);
      if (result === "enabled" || result === "disabled") d.log?.info({ result }, "tenant paper sniper config reconciled");
      else if (want && result === "no_feed") d.log?.warn({}, "paper sniper wanted but the tenant is not on the shared discovery feed yet");
      return result;
    },
  };
}
