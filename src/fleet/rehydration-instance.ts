import { logger } from "../logger.js";
import { getClientById } from "../engine-clients.js";
import { isUserApproved } from "../invites.js";
import { fleetAccess } from "./access-instance.js";
import { renewHostedPairingStateIfNeeded } from "./hosted-pairing-seed.js";
import { fleetManager, tenantRuntimeDir } from "./instance.js";
import { TenantRehydrator } from "./rehydrator.js";

/**
 * The ONE rehydrator for this process, wired to the real DB lookups and the
 * real entitlement renewal (same function bot.ts's /paper_start path uses).
 * Started from src/index.ts after migrations, the identity check and the HTTP
 * server are up; read (counts only) by /healthz.
 */
export const tenantRehydrator = new TenantRehydrator({
  fleet: fleetManager,
  getClientById,
  // Approval AND the fleet access policy (kill switch / founder-only list):
  // a user no longer allowed is treated exactly like a revoked one, in both
  // rehydration and the periodic re-check (their tenant is stopped).
  isUserApproved: async (userId) => (await fleetAccess.isUserAllowed(userId)) && (await isUserApproved(userId)),
  renewHostedEntitlementIfNeeded: async (clientId) => {
    renewHostedPairingStateIfNeeded(tenantRuntimeDir(clientId), clientId);
  },
  log: logger,
});
