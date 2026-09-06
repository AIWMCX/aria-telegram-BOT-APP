/**
 * Restated productization prompt, notification-preferences item — the
 * only one of the mockup's 6 categories (position opened/closed,
 * candidate detected, engine disconnected, daily summary, market
 * degraded) with real, checkable server-side state: a paired device's
 * last_seen_at going stale. The other 5 have no underlying trigger
 * anywhere in this stack — building toggles for them would be UI
 * controlling nothing.
 */
exports.up = (pgm) => {
  pgm.addColumn("engine_clients", {
    offline_notified_at: { type: "timestamptz" },
  });
  pgm.addColumn("users", {
    notify_engine_offline: { type: "boolean", notNull: true, default: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("engine_clients", "offline_notified_at");
  pgm.dropColumn("users", "notify_engine_offline");
};
