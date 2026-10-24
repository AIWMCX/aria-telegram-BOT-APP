import { getLatestActiveClientForUser } from "../engine-clients.js";
import { fleetManager } from "../fleet/instance.js";
import { getUserByTelegramId } from "../users.js";
import { USERS_DOMAIN_ENABLED } from "../config.js";

/**
 * The hosted tenant's runtime directory for a Telegram user, or undefined
 * when there is none yet. The path comes ONLY from FleetManager.runtimeDirFor,
 * which validates the client id (engine_clients.id, a UUID from our own
 * database), never from anything the caller typed.
 */
export async function sniperTenantRuntimeDir(telegramUserId: number | string): Promise<string | undefined> {
  if (!USERS_DOMAIN_ENABLED) return undefined;
  const user = await getUserByTelegramId(Number(telegramUserId));
  if (!user) return undefined;
  const client = await getLatestActiveClientForUser(user.id);
  if (!client || client.hosting_mode !== "hosted") return undefined;
  return fleetManager.runtimeDirFor(client.id);
}
