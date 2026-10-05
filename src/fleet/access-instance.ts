import { FLEET_FLAGS } from "../config.js";
import { getUserById } from "../users.js";
import { createFleetAccess } from "./fleet-access.js";

/** The ONE access policy for this process (kill switch + optional allow-list), shared by the commands, rehydration and the approval re-check. */
export const fleetAccess = createFleetAccess({
  enabled: FLEET_FLAGS.enabled,
  allowedTelegramIds: FLEET_FLAGS.allowedTelegramIds,
  getTelegramIdForUser: async (userId) => (await getUserById(userId))?.telegram_user_id,
});
