import { CONFIG } from "../config.js";
import { FleetManager, realEngineInvocation } from "./fleet-manager.js";

/**
 * Hosted PAPER Engine, Task 4 — the ONE `FleetManager` instance for this
 * process, constructed here (not inside bot.ts) so it's importable from
 * anywhere `src/index.ts` boots the app, per the plan's explicit
 * instruction: a future, separate program
 * (docs/superpowers/specs/2026-09-11-command-console-design.md — not
 * present in this repo/worktree as of this task; noted honestly rather
 * than assumed) will need an HTTP surface calling the SAME Fleet Manager
 * capabilities, and that only works cleanly if there is exactly one
 * `FleetManager` object per process, not one constructed fresh per
 * caller. `bot.ts` imports `fleetManager` from here; it never constructs
 * its own.
 */
export const fleetManager = new FleetManager({
  engineInvocation: realEngineInvocation(CONFIG.ARIA_ENGINE_REPO_PATH),
  tenantsRoot: CONFIG.FLEET_TENANTS_ROOT,
  logsRoot: CONFIG.FLEET_LOGS_ROOT,
  ...(CONFIG.FLEET_MAX_CONCURRENT_TENANTS !== undefined
    ? { maxConcurrentTenants: CONFIG.FLEET_MAX_CONCURRENT_TENANTS }
    : {}),
});

/**
 * Delegates to the ONE `FleetManager` instance's own `runtimeDirFor()` (see
 * that method's docblock in fleet-manager.ts) so a hosted-client-creation or
 * hosted-conversion flow can pre-seed a device identity file into the SAME
 * directory the Fleet Manager will later point `ARIA_RUNTIME_DIR` at.
 *
 * Task 4 review fix (2026-09-18): this used to independently recompute
 * `path.join(tenantsRoot, clientId, ".aria")` itself, duplicating
 * FleetManager's private `runtimeDirFor()` — two copies of the same path
 * convention in two files with nothing enforcing they stay identical.
 * Delegating here means a future change to the convention only has one
 * place to change.
 */
export function tenantRuntimeDir(clientId: string): string {
  return fleetManager.runtimeDirFor(clientId);
}
