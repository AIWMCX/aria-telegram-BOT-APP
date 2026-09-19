import path from "node:path";
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
 * Mirrors FleetManager's own private `runtimeDirFor()` convention
 * (`<tenantsRoot>/<clientId>/.aria`) so a hosted-client-creation flow can
 * pre-seed a device identity file into the SAME directory the Fleet
 * Manager will later point `ARIA_RUNTIME_DIR` at, without either module
 * needing to import the other's private internals.
 */
export function tenantRuntimeDir(clientId: string): string {
  return path.join(CONFIG.FLEET_TENANTS_ROOT, clientId, ".aria");
}
