/**
 * Restated productization prompt — the one real, honestly-backed slice of
 * "granular notification preferences": engine-disconnected alerts. The
 * mockup's other 5 categories (position opened/closed, candidate detected,
 * daily summary, market degraded) have no underlying trigger anywhere in
 * this stack, so no toggle was built for them — a checkbox controlling a
 * notification that can never fire would be worse than not having it.
 */
import { logger } from "./logger.js";
import { findClientsNewlyOffline, markOfflineNotified } from "./engine-clients.js";
import { getUserByTelegramId } from "./users.js";
import { pgPool } from "./db-pg.js";
import { notifyCustomerOfEngineOffline } from "./bot.js";

const OFFLINE_THRESHOLD_MINUTES = 10;

async function getTelegramIdForUser(userId: number): Promise<number | undefined> {
  if (!pgPool) return undefined;
  const { rows } = await pgPool.query<{ telegram_user_id: number }>(
    `SELECT telegram_user_id FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.telegram_user_id;
}

/**
 * offline_notified_at is set BEFORE attempting delivery, same discipline as
 * expiry-warnings.ts: a failed DM (blocked bot, chat never started) must
 * not retry forever on a permanently undeliverable chat.
 */
export async function checkAndSendOfflineAlerts(): Promise<{ sent: number }> {
  let sent = 0;
  for (const client of await findClientsNewlyOffline(OFFLINE_THRESHOLD_MINUTES)) {
    await markOfflineNotified(client.id);
    const telegramUserId = await getTelegramIdForUser(client.user_id);
    if (!telegramUserId) { logger.warn({ clientId: client.id }, "offline alert: telegram user not found"); continue; }
    const user = await getUserByTelegramId(telegramUserId);
    if (user && user.notify_engine_offline === false) continue; // opted out — still marked notified, so it doesn't re-check every tick
    await notifyCustomerOfEngineOffline(telegramUserId, client.device_name, OFFLINE_THRESHOLD_MINUTES);
    sent++;
  }
  return { sent };
}

/** Runs an immediate check, then on a fixed interval — a check failure never kills the interval; the next tick just tries again. */
export function startOfflineAlertScheduler(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const { sent } = await checkAndSendOfflineAlerts();
      if (sent > 0) logger.info({ sent }, "engine-offline alerts sent");
    } catch (err) {
      logger.error({ err }, "engine-offline alert check failed — will retry next interval");
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
