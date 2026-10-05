/**
 * Who may use hosted PAPER right now: the FLEET_ENABLED kill switch plus the
 * optional founder-only allow-list. One object, used by the Telegram
 * commands, the rehydrator and the periodic approval check, so the three
 * cannot disagree.
 */
export interface FleetAccess {
  readonly enabled: boolean;
  /** Sync check by Telegram id (commands). False when the fleet is disabled. */
  isTelegramIdAllowed(telegramUserId: number | string): boolean;
  /** Async check by internal user id (rehydration / approval re-check). Throws only if the lookup itself fails. */
  isUserAllowed(userId: number): Promise<boolean>;
}

export function createFleetAccess(opts: {
  enabled: boolean;
  allowedTelegramIds: ReadonlySet<string> | undefined;
  getTelegramIdForUser: (userId: number) => Promise<string | number | undefined>;
}): FleetAccess {
  const idAllowed = (id: number | string): boolean => opts.enabled && (!opts.allowedTelegramIds || opts.allowedTelegramIds.has(String(id)));
  return {
    enabled: opts.enabled,
    isTelegramIdAllowed: idAllowed,
    async isUserAllowed(userId) {
      if (!opts.enabled) return false;
      if (!opts.allowedTelegramIds) return true;
      const tg = await opts.getTelegramIdForUser(userId);
      return tg !== undefined && idAllowed(tg);
    },
  };
}
