import { CONFIG, FLEET_FLAGS, PAPER_SNIPER_FLAGS } from "../config.js";
import { getClientById } from "../engine-clients.js";
import { getUserById } from "../users.js";
import { createSniperTenantPreparer, engineSupportsPaperSniper, sniperUnavailableReason } from "../paper-sniper/tenant-prepare.js";
import { logger } from "../logger.js";
import { parseDiscoveryFlags, parseEventStaleMs, discoveryPaths, type DiscoveryFlags } from "./discovery-config.js";
import { DiscoveryProcess, engineSupportsDiscovery, type DiscoveryHealthBlock } from "./discovery-process.js";
import { prepareTenantRpc, rpcRelayUsable, unregisterTenantRpc } from "../rpc-relay/instance.js";
import { rpcRelayDecision } from "../rpc-relay/gating.js";
import { reconcileTenantDiscoverySync } from "./tenant-discovery-seed.js";

/**
 * The ONE shared-discovery supervisor for this process (PR B2). Disabled
 * (and spawning nothing) unless DISCOVERY_ENABLED=true AND both stream URLs
 * are valid. The URLs stay inside `flags.endpoints` -> the DiscoveryProcess
 * env; nothing exported here carries them.
 */
const ENGINE_PATH = CONFIG.ARIA_ENGINE_REPO_PATH;
const flags: DiscoveryFlags = parseDiscoveryFlags(process.env);
export const DISCOVERY_PATHS = discoveryPaths(CONFIG.FLEET_TENANTS_ROOT, CONFIG.FLEET_LOGS_ROOT);

export const discoveryProcess: DiscoveryProcess | undefined = flags.enabled
  ? new DiscoveryProcess({ enginePath: ENGINE_PATH, endpoints: flags.endpoints, paths: DISCOVERY_PATHS, eventStaleMs: parseEventStaleMs(process.env), log: logger })
  : undefined;

export function startDiscovery(): void {
  if (!discoveryProcess) {
    logger.info({ reason: flags.enabled ? "" : flags.reason }, "shared discovery is DISABLED");
    return;
  }
  discoveryProcess.start();
}

/** /healthz block. Fail closed: anything not fully enabled reports enabled:false with a reason (never a value). */
export function discoveryHealth(): DiscoveryHealthBlock {
  if (!flags.enabled) return { enabled: false, running: false, reason: flags.reason };
  if (!engineSupportsDiscovery(ENGINE_PATH)) {
    return { enabled: false, running: false, reason: "packaged engine does not support `aria discovery run` (bump ARIA_ENGINE_COMMIT_SHA)" };
  }
  return discoveryProcess!.health();
}

/**
 * PR E: the paper sniper seeding step + /healthz block. Usable only when the
 * sniper switch, the fleet, the shared discovery AND an engine containing the
 * sniper are all present; otherwise nothing is seeded and anything we seeded
 * earlier is reverted at the tenant's next spawn.
 */
const sniperDeps = {
  flags: PAPER_SNIPER_FLAGS,
  discoveryUsable: () => flags.enabled && engineSupportsDiscovery(ENGINE_PATH),
  engineHasSniper: () => engineSupportsPaperSniper(ENGINE_PATH),
  feedPath: DISCOVERY_PATHS.feedPath,
  ownerTelegramId: async (clientId: string) => {
    const client = await getClientById(clientId);
    if (!client) return undefined;
    return (await getUserById(client.user_id))?.telegram_user_id;
  },
  log: logger,
};
const sniperPreparer = createSniperTenantPreparer(sniperDeps);

/** /healthz `paperSniper` block: {enabled, tenants, reason}. `tenants` = tenants this process has seeded since boot. Never a value or id. */
export function paperSniperHealth(): { enabled: boolean; tenants: number; reason?: string } {
  const reason = sniperUnavailableReason(sniperDeps, FLEET_FLAGS.enabled);
  return reason ? { enabled: false, tenants: 0, reason } : { enabled: true, tenants: sniperPreparer.seededCount() };
}

/** FleetManager.onTenantStopped hook (PR F1): a stopped/removed tenant's relay token stops working at once; the next spawn re-registers it. */
export function onTenantStopped(clientId: string): void {
  unregisterTenantRpc(clientId);
}

/** FleetManager.prepareTenantRuntime hook: seed (or un-seed) the tenant's discovery source, then its paper sniper config, before it spawns. Synchronous atomic file edits: no child process, no waiting (the sniper step does one DB read only when the sniper is enabled). */
export async function prepareTenantRuntime(clientId: string, runtimeDir: string): Promise<void> {
  if (!(flags.enabled && !engineSupportsDiscovery(ENGINE_PATH))) {
    const result = reconcileTenantDiscoverySync({ runtimeDir, feedPath: DISCOVERY_PATHS.feedPath, enabled: flags.enabled });
    if (result === "enabled" || result === "disabled") logger.info({ result }, "tenant discovery source reconciled");
  }
  let sniperResult: string = "skipped";
  try {
    sniperResult = await sniperPreparer.prepare(clientId, runtimeDir);
  } catch (err) {
    logger.warn({ errName: (err as Error)?.name }, "tenant paper sniper config reconcile failed; starting with the existing config");
  }
  // PR F1: paper-sniper tenants use the private read-only RPC relay (the paid provider key never reaches them).
  // A transient/failed sniper lookup ("skipped") leaves rpc.url alone.
  const rpcWant = rpcRelayDecision(sniperResult, rpcRelayUsable(), sniperPreparer.isSeeded(clientId));
  if (rpcWant !== "leave") prepareTenantRpc(clientId, runtimeDir, rpcWant);
}
