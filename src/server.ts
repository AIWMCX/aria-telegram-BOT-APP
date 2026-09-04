import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CONFIG, PAYMENTS_ENABLED, USERS_DOMAIN_ENABLED, ENTITLEMENT_ISSUANCE_ENABLED } from "./config.js";
import { logger } from "./logger.js";
import { verifyInitData } from "./telegram-auth.js";
import { upsertLead, recentSubmissionsByUser, totalLeads, getLatestLeadByTgUser } from "./leads.js";
import { sendAdminLeadNotification, sendLicenseEmail } from "./email.js";
import { notifyAdminOfLicense, notifyCustomerLicenseIssued } from "./bot.js";
import { issueLicense, getActiveLicenseForLead } from "./licenses.js";
import { createCheckoutSession, handleStripeWebhook } from "./stripe.js";
import { upsertUserFromTelegram } from "./users.js";
import { createPairingCode, consumePairingCode } from "./engine-pairing.js";
import { registerClient, getClientById, atomicAdvanceSequence } from "./engine-clients.js";
import { getOrCreateTrialEntitlement, getEntitlementForUser } from "./engine-entitlements.js";
import { issueReal1BetaEntitlementToken, REAL1_BETA_DURATION_SECONDS } from "./engine-entitlement-signer.js";
import { canonicalSyncMessage, verifyDeviceSignature, isTimestampWithinReplayWindow, type SyncPayload } from "./device-auth.js";
import { recordSnapshot } from "./engine-snapshots.js";
import { recordEventBatch } from "./engine-events.js";
import { getPendingCommands, ackCommand } from "./engine-commands.js";
import { isUserApproved, markInvitePaired } from "./invites.js";

export const app = new Hono();

const SolanaAddress = z.string().trim().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "invalid Solana address");

const SubmitBody = z.object({
  initData: z.string().min(10, "initData missing — open this via the Telegram bot"),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  interest: z.string().trim().max(500).optional(),
  website: z.string().max(200).optional(), // honeypot — real users never fill this
});

const CheckoutBody = z.object({
  initData: z.string().min(10),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  wallet: SolanaAddress,
  tier: z.enum(["standard", "pro"]),
  website: z.string().max(200).optional(), // honeypot
});

app.get("/healthz", (c) =>
  c.json({ ok: true, uptime: process.uptime(), leads: totalLeads(), paymentsEnabled: PAYMENTS_ENABLED }),
);

/**
 * Unauthenticated product-state summary consumed by the Mini App's reality
 * banner (public/app.js loadReality()). Describes overall product
 * configuration on THIS deployment — not a per-device/per-user snapshot
 * (that's /api/engine/me). Every field below is a real, static fact about
 * this deployment or a real exported config const — nothing here is
 * fabricated or hardcoded optimism.
 */
const VALID_ENVIRONMENTS = new Set(["production", "staging", "development"]);
app.get("/api/product-reality", (c) =>
  c.json({
    ok: true,
    reality: {
      environment: VALID_ENVIRONMENTS.has(process.env.RAILWAY_ENVIRONMENT_NAME ?? "")
        ? process.env.RAILWAY_ENVIRONMENT_NAME
        : "production",
      network: "solana-mainnet",
      dataMode: "live",
      executionMode: "paper",
      controlState: USERS_DOMAIN_ENABLED ? "running" : "stopped",
      paymentsEnabled: PAYMENTS_ENABLED,
    },
  }),
);

/**
 * Returning-user account restore. Verifies Telegram initData (sent as a
 * header, never a query param, so it never lands in access logs or a
 * Referer header) and returns the caller's OWN account/license state —
 * there is no code path here that can return a different Telegram user's
 * license, because the identity is derived entirely from the verified
 * signature, never from client-supplied input.
 *
 * Returns the full license token (not just tier/expiry) so a returning
 * user can recover their key from the Mini App itself even if the
 * original delivery email never arrived — license delivery must not
 * depend on email being reliable.
 */
app.get("/api/me", (c) => {
  const initData = c.req.header("x-init-data");
  if (!initData) return c.json({ ok: false, error: "missing initData" }, 400);

  const verified = verifyInitData(initData);
  if (!verified) return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);

  const lead = getLatestLeadByTgUser(verified.user.id);
  if (!lead?.id) return c.json({ ok: true, hasAccount: false, license: null });

  const license = getActiveLicenseForLead(lead.id);
  if (!license) return c.json({ ok: true, hasAccount: true, license: null });

  return c.json({
    ok: true,
    hasAccount: true,
    license: { id: license.id, token: license.token, tier: license.tier, expiresAt: license.expiresAt },
    email: lead.email,
  });
});

/**
 * Real ARIA identity — per docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3a. Additive
 * to `/api/me`: creates/restores a `users` row keyed on telegram_user_id
 * alone (not the leads table's tg_user_id+email pair). This is the account
 * domain the funded product will build on; it does not yet return a
 * wallet, balance, or anything financial — those don't exist until
 * wallet_accounts/ledger are wired to a real SignerPort adapter.
 */
app.post("/api/auth/telegram", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = z.object({ initData: z.string().min(10) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    logger.warn("auth/telegram rejected — bad initData");
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  if (!USERS_DOMAIN_ENABLED) {
    return c.json({ ok: false, error: "Account service not yet available." }, 503);
  }

  try {
    const user = await upsertUserFromTelegram({
      id: verified.user.id,
      username: verified.user.username,
      first_name: verified.user.first_name,
      last_name: verified.user.last_name,
    });
    return c.json({
      ok: true,
      user: {
        id: user.id,
        accountStatus: user.account_status,
        createdAt: user.created_at,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "auth/telegram failed — Postgres users domain unavailable");
    return c.json({ ok: false, error: "Account service temporarily unavailable." }, 503);
  }
});

/**
 * REAL-1 Task 4 — issues a pairing code for the caller's own account.
 * Telegram-authenticated: the code is a bearer credential, but who it's
 * ISSUED to is never in question, because identity here comes from
 * verified initData, never from client input. Returns the raw code
 * exactly once — it is never persisted or logged in plaintext.
 */
app.post("/api/engine/pairing-code", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = z.object({ initData: z.string().min(10) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  if (!USERS_DOMAIN_ENABLED) {
    return c.json({ ok: false, error: "Account service not yet available." }, 503);
  }

  try {
    const user = await upsertUserFromTelegram({
      id: verified.user.id,
      username: verified.user.username,
      first_name: verified.user.first_name,
      last_name: verified.user.last_name,
    });

    // First-10 beta control: engine access (a real pairing code, which lets
    // `aria pair` register a device) is invite-only right now. Everything
    // else in the Mini App remains open — this is the one real gate.
    if (!(await isUserApproved(user.id))) {
      return c.json({ ok: false, error: "ARIA is in a controlled first-beta right now — ask the person who told you about it for an invite link." }, 403);
    }

    const { code, expiresAt } = await createPairingCode(user.id);
    return c.json({ ok: true, code, expiresAt });
  } catch (err: any) {
    logger.error({ err }, "pairing-code issuance failed");
    return c.json({ ok: false, error: "Pairing service temporarily unavailable." }, 503);
  }
});

/**
 * REAL-1 Task 4 — consumes a pairing code and registers a device. No
 * signature required here: the device has no server-known public key
 * yet (this call is what establishes it), and the pairing code itself —
 * single-use, short-lived, tied to one user — is the authorization,
 * exactly the trust-on-first-use model SSH/GitHub device flows use.
 * `devicePublicKey` is a public key. This endpoint has no code path that
 * accepts, stores, or could accept a private key.
 */
app.post("/api/engine/pair", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = z.object({
    code: z.string().min(10),
    devicePublicKey: z.string().min(32),
    deviceName: z.string().max(100).optional(),
    platform: z.string().max(50).optional(),
    engineVersion: z.string().max(50).optional(),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  if (!USERS_DOMAIN_ENABLED) {
    return c.json({ ok: false, error: "Pairing service not yet available." }, 503);
  }

  try {
    const consumed = await consumePairingCode(parsed.data.code);
    if (!consumed.ok) {
      return c.json({ ok: false, error: "Pairing code invalid, expired, or already used." }, 401);
    }

    const client = await registerClient({
      userId: consumed.userId,
      devicePublicKey: parsed.data.devicePublicKey,
      deviceName: parsed.data.deviceName,
      platform: parsed.data.platform,
      engineVersion: parsed.data.engineVersion,
    });

    // First-10 beta control: this is the funnel's real "paired" milestone —
    // a device pairing code could only have been minted for an approved
    // (activated) invite, so this call is a no-op unless that's true.
    // Never fails pairing itself if it errors.
    try {
      await markInvitePaired(consumed.userId);
    } catch (err: any) {
      logger.warn({ err }, "markInvitePaired failed — device is still paired");
    }

    // REAL-1 Task 8 — issue the device's initial signed ARIAE1 entitlement
    // in the same call, so a paired device can immediately verify it has
    // real (not assumed) paper-trading access. Failure here does NOT fail
    // pairing itself — a paired-but-unentitled device is a real, valid
    // state (e.g. entitlement issuance briefly misconfigured); the device
    // is still registered either way.
    let entitlementToken: string | undefined;
    if (ENTITLEMENT_ISSUANCE_ENABLED) {
      try {
        await getOrCreateTrialEntitlement({
          userId: consumed.userId,
          durationSeconds: REAL1_BETA_DURATION_SECONDS,
          maxPaperBuyLamports: 5_000_000n,
          maxPaperPositions: 3,
        });
        entitlementToken = issueReal1BetaEntitlementToken(client.id, randomUUID()).token;
      } catch (err: any) {
        logger.error({ err }, "entitlement issuance failed during pairing — device is still paired");
      }
    }

    return c.json({ ok: true, clientId: client.id, pairedAt: client.paired_at, entitlementToken });
  } catch (err: any) {
    // A duplicate device_public_key (unique constraint) surfaces here as a
    // generic DB error — treated as a conflict, not a 500, since it's a
    // legitimate client-input case (re-pairing with an already-known key).
    logger.error({ err }, "device pairing failed");
    return c.json({ ok: false, error: "Pairing failed — this device key may already be registered." }, 409);
  }
});

/**
 * REAL-1 Task 4 — the minimal authenticated, replay-resistant envelope.
 * No meaningful payload semantics exist yet (that's Task 7/8's sync
 * protocol, per the design doc's engine_snapshots/engine_events/
 * engine_commands) — this endpoint exists to prove the auth+replay
 * mechanism itself works end-to-end before anything is built on top of it.
 */
const SYNC_PAYLOAD_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heartbeat") }),
  z.object({ kind: z.literal("snapshot"), snapshot: z.unknown() }),
  z.object({ kind: z.literal("event_batch"), events: z.array(z.object({
    eventType: z.string().min(1), occurredAt: z.string().min(1), payload: z.unknown(),
  })) }),
  z.object({ kind: z.literal("command_ack"), commandId: z.string().uuid(), status: z.enum(["acknowledged", "completed", "failed"]), detail: z.string().optional() }),
  z.object({ kind: z.literal("diagnostic_status"), ready: z.boolean(), version: z.string().min(1), executionMode: z.literal("paper") }),
]);

app.post("/api/engine/sync", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = z.object({
    clientId: z.string().uuid(),
    sequence: z.number().int().positive(),
    timestamp: z.number().int().positive(),
    payload: SYNC_PAYLOAD_SCHEMA,
    signature: z.string().min(20),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }
  const { clientId, sequence, timestamp, payload, signature } = parsed.data;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!isTimestampWithinReplayWindow(timestamp, nowSeconds)) {
    return c.json({ ok: false, error: "Request timestamp outside the acceptable window." }, 401);
  }

  if (!USERS_DOMAIN_ENABLED) {
    return c.json({ ok: false, error: "Sync service not yet available." }, 503);
  }

  try {
    const client = await getClientById(clientId);
    if (!client || client.status !== "active") {
      return c.json({ ok: false, error: "Unknown or revoked device." }, 401);
    }

    const message = canonicalSyncMessage(clientId, sequence, timestamp, payload as SyncPayload);
    if (!verifyDeviceSignature(client.device_public_key, message, signature)) {
      return c.json({ ok: false, error: "Invalid signature." }, 401);
    }

    // SYNC_DESYNC_INVESTIGATION: safe diagnostic tuple only — clientId,
    // truncated public-key fingerprint, incoming/stored sequence, payload
    // kind. Never a signature, private key, or entitlement token. This is
    // the server side of the local-vs-server sequence comparison needed to
    // root-cause the sequence-desync bug (see docs/ARIA_PRODUCT_SCALE_STATE.md).
    const advanced = await atomicAdvanceSequence(clientId, BigInt(sequence));
    logger.info(
      {
        clientId,
        devicePublicKeyFingerprint: client.device_public_key.slice(0, 12),
        incomingSequence: sequence,
        serverLastSequenceBeforeThisRequest: client.last_sequence,
        payloadKind: payload.kind,
        advanced,
      },
      "sync sequence check",
    );
    if (!advanced) {
      // currentSequence lets a desynced client self-heal (see pairing-state.ts's
      // resyncSequence) instead of retrying the same rejected number forever —
      // client.last_sequence was read moments ago in this same request, so it's
      // the authoritative value the failed advance was compared against.
      return c.json({ ok: false, error: "Sequence not strictly increasing — stale or replayed request.", currentSequence: client.last_sequence }, 409);
    }

    // Every payload kind reaches this point already authenticated and
    // replay-protected — dispatch is pure bookkeeping from here.
    switch (payload.kind) {
      case "heartbeat":
        break; // no persisted side effect — last_seen_at was already updated by atomicAdvanceSequence above
      case "snapshot":
        await recordSnapshot(clientId, sequence, payload.snapshot);
        break;
      case "event_batch":
        await recordEventBatch(clientId, sequence, payload.events);
        break;
      case "command_ack":
        // A stale/unknown/out-of-order ack is logged, not fatal — the
        // envelope itself is still a valid, accepted sync exchange.
        await ackCommand(payload.commandId, clientId, payload.status, payload.detail)
          .then((result) => { if (!result.applied) logger.warn({ clientId, commandId: payload.commandId, reason: result.reason }, "command_ack not applied"); });
        break;
      case "diagnostic_status":
        // Accepted but not yet persisted — no dedicated table exists for
        // this yet; a future task can add one without touching the wire
        // format, since the client already sends it correctly today.
        break;
    }

    // Every response — regardless of which payload kind was sent — carries
    // the LIVE entitlement status and any pending commands. This is the
    // actual revocation-propagation mechanism: an engine that syncs even a
    // bare heartbeat still learns immediately if its entitlement was
    // revoked server-side, which offline signature verification alone can
    // never detect before the token's natural 7-day expiry.
    let entitlementStatus: { status: string; expiresAt: string | null } | undefined;
    try {
      const entitlement = await getEntitlementForUser(client.user_id, "real-1");
      if (entitlement) entitlementStatus = { status: entitlement.status, expiresAt: entitlement.expires_at };
    } catch (err) {
      logger.warn({ err, clientId }, "entitlement status lookup failed during sync — omitting from response, not failing the sync");
    }

    let pendingCommands: Array<{ commandId: string; type: string; payload: unknown; issuedAt: string; expiresAt: string; expectedState?: string }> = [];
    try {
      const pending = await getPendingCommands(clientId);
      pendingCommands = pending.map((cmd) => ({
        commandId: cmd.id, type: cmd.type, payload: cmd.payload,
        issuedAt: cmd.issued_at, expiresAt: cmd.expires_at,
        expectedState: cmd.expected_state ?? undefined,
      }));
    } catch (err) {
      logger.warn({ err, clientId }, "pending-command lookup failed during sync — omitting from response, not failing the sync");
    }

    return c.json({ ok: true, entitlementStatus, pendingCommands });
  } catch (err: any) {
    logger.error({ err }, "engine sync failed");
    return c.json({ ok: false, error: "Sync service temporarily unavailable." }, 503);
  }
});

/** Trial signup — verifies Telegram identity, saves lead, issues a trial license immediately. */
app.post("/api/submit", async (c) => {
  const ua = c.req.header("user-agent") ?? "";
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = SubmitBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }
  if (parsed.data.website) {
    // Honeypot tripped — reject with the same generic shape as any other
    // validation failure so bots can't distinguish this from a real rejection.
    return c.json({ ok: false, error: "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    logger.warn({ ua }, "submit rejected — bad initData");
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  if (recentSubmissionsByUser(verified.user.id) >= 3) {
    return c.json({ ok: false, error: "Too many submissions. Please try again later." }, 429);
  }

  const lead = {
    tg_user_id: verified.user.id,
    tg_username: verified.user.username,
    tg_first_name: verified.user.first_name,
    tg_last_name: verified.user.last_name,
    name: parsed.data.name,
    email: parsed.data.email,
    wallet: parsed.data.wallet,
    interest: parsed.data.interest,
  };

  const leadId = upsertLead(lead);
  const leadWithId = { ...lead, id: leadId };
  const license = issueLicense(leadWithId, "trial");

  logger.info({ leadId, licenseId: license.id }, "trial issued");

  void (async () => {
    await sendAdminLeadNotification(lead, leadId);
    await sendLicenseEmail(leadWithId, license);
    await notifyAdminOfLicense(leadWithId, license, "trial");
    await notifyCustomerLicenseIssued(leadWithId, license);
  })();

  return c.json({ ok: true, leadId, licenseId: license.id, tier: "trial", expiresAt: license.expiresAt });
});

/** Paid tier — creates a Stripe Checkout session. */
app.post("/api/checkout", async (c) => {
  if (!PAYMENTS_ENABLED) {
    return c.json({ ok: false, error: "Payments are not yet configured. Try again soon." }, 503);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid JSON" }, 400); }

  const parsed = CheckoutBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }

  const verified = verifyInitData(parsed.data.initData);
  if (!verified) {
    return c.json({ ok: false, error: "Telegram verification failed. Open via the bot, not directly." }, 401);
  }

  const lead = {
    tg_user_id: verified.user.id,
    tg_username: verified.user.username,
    tg_first_name: verified.user.first_name,
    tg_last_name: verified.user.last_name,
    name: parsed.data.name,
    email: parsed.data.email,
    wallet: parsed.data.wallet,
  };
  const leadId = upsertLead(lead);

  try {
    const { url, orderId } = await createCheckoutSession({ leadId, tier: parsed.data.tier, email: parsed.data.email });
    return c.json({ ok: true, checkoutUrl: url, orderId });
  } catch (err: any) {
    logger.error({ err }, "checkout session creation failed");
    return c.json({ ok: false, error: err?.message ?? "checkout failed" }, 500);
  }
});

/** Stripe webhook — signature-verified, no Telegram auth (Stripe calls this server-to-server). */
app.post("/api/webhook/stripe", async (c) => {
  if (!PAYMENTS_ENABLED) return c.json({ ok: false, error: "not configured" }, 503);

  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ ok: false, error: "missing signature" }, 400);

  const rawBody = await c.req.text();
  try {
    const result = await handleStripeWebhook(rawBody, signature);
    logger.info({ result }, "stripe webhook processed");
    return c.json({ ok: true, result });
  } catch (err: any) {
    logger.error({ err }, "stripe webhook verification/handling failed");
    return c.json({ ok: false, error: err?.message ?? "webhook error" }, 400);
  }
});

/**
 * Retired legacy post-checkout lookup. An order ID is not an authentication
 * capability, so this route must never disclose order or license data.
 * Returning users recover licenses through Telegram-authenticated `/api/me`.
 */
app.get("/api/license-by-order/:orderId", (c) =>
  c.json({ ok: false, error: "endpoint retired; use authenticated /api/me" }, 410),
);

app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

export function startServer(): void {
  serve({ fetch: app.fetch, port: CONFIG.PORT, hostname: "0.0.0.0" }, (info) => {
    logger.info(
      { port: info.port, publicUrl: CONFIG.PUBLIC_URL, paymentsEnabled: PAYMENTS_ENABLED },
      "http server listening",
    );
  });
}
