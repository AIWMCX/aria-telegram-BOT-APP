import { logger } from "../logger.js";
import { getClientById } from "../engine-clients.js";
import { isUserApproved } from "../invites.js";
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
  isUserApproved,
  renewHostedEntitlementIfNeeded: async (clientId) => {
    renewHostedPairingStateIfNeeded(tenantRuntimeDir(clientId), clientId);
  },
  log: logger,
});
