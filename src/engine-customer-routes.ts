import { z } from "zod";
import { app } from "./server.js";
import { logger } from "./logger.js";
import { verifyInitData } from "./telegram-auth.js";
import { getUserByTelegramId } from "./users.js";
import { getLatestActiveClientForUser } from "./engine-clients.js";
import { getLatestSnapshot } from "./engine-snapshots.js";
import { getRecentEvents } from "./engine-events.js";
import { getEntitlementForUser } from "./engine-entitlements.js";
import { enqueueCommand, type EngineCommandType } from "./engine-commands.js";

const ONLINE_WINDOW_MS = 45_000;
const CUSTOMER_COMMANDS = ["paper_pause", "paper_stop", "request_snapshot"] as const;
const CustomerCommandBody = z.object({
  initData: z.string().min(10),
  command: z.enum(CUSTOMER_COMMANDS),
});

function verifyHeaderInitData(raw: string | undefined) {
  if (!raw) return { ok: false as const, status: 400 as const, error: "missing initData" };
  const verified = verifyInitData(raw);
  if (!verified) return { ok: false as const, status: 401 as const, error: "Telegram verification failed. Open via the bot, not directly." };
  return { ok: true as const, verified };
}

/**
 * Customer engine dashboard. The browser never supplies a clientId: the
 * server derives Telegram identity from signed initData, resolves that
 * user's active device, then returns only that device's latest snapshot and
 * bounded event tail. This is the ownership boundary for the Mini App.
 */
app.get("/api/engine/me", async (c) => {
  const auth = verifyHeaderInitData(c.req.header("x-init-data"));
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);

  try {
    const user = await getUserByTelegramId(auth.verified.user.id);
    if (!user) {
      return c.json({ ok: true, paired: false, device: null, entitlement: null, snapshot: null, events: [] });
    }

    const client = await getLatestActiveClientForUser(user.id);
    if (!client) {
      const entitlement = await getEntitlementForUser(user.id, "real-1");
      return c.json({
        ok: true,
        paired: false,
        device: null,
        entitlement: entitlement ? { status: entitlement.status, expiresAt: entitlement.expires_at } : null,
        snapshot: null,
        events: [],
      });
    }

    const [storedSnapshot, recentEvents, entitlement] = await Promise.all([
      getLatestSnapshot(client.id),
      getRecentEvents(client.id, 20),
      getEntitlementForUser(user.id, "real-1"),
    ]);

    const lastSeenAt = client.last_seen_at;
    const online = Boolean(lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS);

    return c.json({
      ok: true,
      paired: true,
      device: {
        id: client.id,
        name: client.device_name,
        platform: client.platform,
        engineVersion: client.engine_version,
        online,
        lastSeenAt,
      },
      entitlement: entitlement ? { status: entitlement.status, expiresAt: entitlement.expires_at } : null,
      snapshot: storedSnapshot ? { data: storedSnapshot.payload, receivedAt: storedSnapshot.created_at, sequence: storedSnapshot.sequence } : null,
      events: recentEvents.map((event) => ({
        id: event.id,
        type: event.event_type,
        occurredAt: event.occurred_at,
        receivedAt: event.received_at,
        data: event.payload,
      })),
      capabilities: {
        paperPause: online,
        paperStop: true,
        requestSnapshot: online,
        remoteColdStart: false,
      },
    });
  } catch (err) {
    logger.error({ err }, "customer engine dashboard unavailable");
    return c.json({ ok: false, error: "Engine account service temporarily unavailable." }, 503);
  }
});

/**
 * Telegram-authenticated customer command entrypoint. Commands are always
 * scoped to the caller's own latest active device. REAL-1 intentionally
 * exposes no buy/sell/live command and no arbitrary clientId.
 */
app.post("/api/engine/command", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = CustomerCommandBody.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);

  try {
    const user = await getUserByTelegramId(verified.user.id);
    if (!user) return c.json({ ok: false, error: "No ARIA account found for this Telegram user." }, 404);

    const client = await getLatestActiveClientForUser(user.id);
    if (!client) return c.json({ ok: false, error: "No active paired ARIA device." }, 409);

    const entitlement = await getEntitlementForUser(user.id, "real-1");
    if (parsed.data.command !== "paper_stop" && (!entitlement || !["trial", "active"].includes(entitlement.status))) {
      return c.json({ ok: false, error: "Paper access is not active. STOP remains available." }, 403);
    }

    const type = parsed.data.command as EngineCommandType;
    const ttlSeconds = type === "paper_stop" ? 120 : type === "paper_pause" ? 60 : 30;
    const command = await enqueueCommand({ clientId: client.id, type, ttlSeconds });

    logger.info({ commandId: command.id, clientId: client.id, type }, "customer engine command enqueued");
    return c.json({ ok: true, commandId: command.id, command: type, expiresAt: command.expires_at });
  } catch (err) {
    logger.error({ err }, "customer engine command unavailable");
    return c.json({ ok: false, error: "Engine command service temporarily unavailable." }, 503);
  }
});
