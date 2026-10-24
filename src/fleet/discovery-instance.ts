import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { parseDiscoveryFlags, discoveryPaths, type DiscoveryFlags } from "./discovery-config.js";
import { DiscoveryProcess, engineSupportsDiscovery, type DiscoveryHealthBlock } from "./discovery-process.js";
import { engineConfigSetRunner, reconcileTenantDiscovery } from "./tenant-discovery-seed.js";

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
  ? new DiscoveryProcess({ enginePath: ENGINE_PATH, endpoints: flags.endpoints, paths: DISCOVERY_PATHS, log: logger })
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

/** FleetManager.prepareTenantRuntime hook: seed (or un-seed) the tenant's discovery source before it spawns. */
export async function prepareTenantRuntime(_clientId: string, runtimeDir: string): Promise<void> {
  if (flags.enabled && !engineSupportsDiscovery(ENGINE_PATH)) return;
  const result = await reconcileTenantDiscovery({
    runtimeDir,
    feedPath: DISCOVERY_PATHS.feedPath,
    enabled: flags.enabled,
    run: engineConfigSetRunner(ENGINE_PATH),
  });
  if (result !== "unchanged") logger.info({ result }, "tenant discovery source reconciled");
}
