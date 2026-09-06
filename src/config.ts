import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  // ── Telegram ──────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(20, "TELEGRAM_BOT_TOKEN required (get from @BotFather)"),
  ADMIN_TELEGRAM_CHAT_ID: z.string().optional().default(""),
  PUBLIC_URL: z.string().url("PUBLIC_URL must be a full https:// URL"),

  // ── Telegram transport (2026-09-04 incident: a persistent, unidentified
  // second getUpdates poller made long polling unreliable in production —
  // ~57% command delivery in a measured test. Webhook mode gives Telegram
  // exactly one registered destination per bot token; there is no "second
  // webhook" failure mode the way there's a "second poller" one.
  // Defaults to "polling" so a bare local `npm run dev` still works with
  // zero extra setup — production sets this to "webhook" explicitly. ──
  TELEGRAM_TRANSPORT: z.enum(["webhook", "polling"]).default("polling"),
  // Compared against Telegram's X-Telegram-Bot-Api-Secret-Token header on
  // every webhook POST — required whenever transport=webhook, checked
  // below (zod can't easily cross-validate two fields inline here).
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),

  // ── Email ─────────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().min(10, "RESEND_API_KEY required (get from resend.com)"),
  ADMIN_EMAIL: z.string().email("ADMIN_EMAIL must be a valid email"),
  FROM_EMAIL: z.string().email().default("onboarding@resend.dev"),

  // ── License signing (required — run `npm run keygen` first) ─────────────
  ARIA_LICENSE_PRIVATE_D: z.string().min(20, "ARIA_LICENSE_PRIVATE_D required — run `npm run keygen`"),
  ARIA_LICENSE_PUBLIC_X: z.string().min(20, "ARIA_LICENSE_PUBLIC_X required — run `npm run keygen`"),

  // ── Stripe (optional — trial tier works without it; required for paid tiers) ──
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_STANDARD_PRICE_ID: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),

  // ── $rypto$ community redirect (optional) ────────────────────────────────
  // Invite link for the $rypto$ Telegram channel/group. When set, a
  // "Join $RYPTO$" prompt fires right after a trial or purchase succeeds —
  // the moment the user has just gotten real value, not before.
  RYPTO_CHANNEL_URL: z.string().url().optional(),

  // ── Server ────────────────────────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DB_PATH: z.string().default("./data/aria.db"),

  // ── Postgres (optional — for the new funded-account domain only, see
  // docs/ARIA_FUNDS_ARCHITECTURE_V1.md. The license product above never
  // reads this; absent locally/in CI, that migration step is just skipped) ──
  DATABASE_URL: z.string().optional(),

  // ── Ledger self-test (temporary, manual — see src/ledger-selftest.ts) ──
  // Set to the literal string "true" on Railway to run the self-test once
  // on boot, check logs, then unset it. Never leaves data behind (rolls
  // back its own transaction) but is not meant to run on every normal
  // boot. z.coerce.boolean() is deliberately NOT used here — it coerces
  // via JS Boolean(str), and Boolean("false") is true (any non-empty
  // string is truthy), so setting this to "false" would silently never
  // turn it off. Exact string match instead.
  RUN_LEDGER_SELFTEST: z.string().optional().transform((v) => v === "true"),

  // ── Engine control self-test (temporary, manual — see
  // src/engine-control-selftest.ts). Same exact-string-match gate as above,
  // for the same reason (z.coerce.boolean's Boolean("false") === true bug).
  RUN_ENGINE_CONTROL_SELFTEST: z.string().optional().transform((v) => v === "true"),

  // ── Engine auth self-test (temporary, manual — see
  // src/engine-auth-selftest.ts). Same exact-string-match gate.
  RUN_ENGINE_AUTH_SELFTEST: z.string().optional().transform((v) => v === "true"),

  // ── Engine sync-protocol self-test (temporary, manual — see
  // src/engine-sync-selftest.ts). Same exact-string-match gate.
  RUN_ENGINE_SYNC_SELFTEST: z.string().optional().transform((v) => v === "true"),

  // ── Sequence-desync reproduction (temporary, manual — see
  // src/engine-sync-desync-repro.ts). Same exact-string-match gate.
  RUN_SYNC_DESYNC_REPRO: z.string().optional().transform((v) => v === "true"),

  // ── ARIAE1 entitlement signing (optional — gates real entitlement
  // issuance; without it, pairing still works but returns no entitlement
  // token). A DIFFERENT keypair from ARIA_LICENSE_PRIVATE_D/PUBLIC_X above
  // — that one signs the legacy product's license tokens, this one signs
  // aria-engine's ARIAE1 tokens. Never share these across the two token
  // formats, even though both are Ed25519/JWK "x" — different signing
  // domains should never share a key. The private half must never leave
  // this service; aria-engine only ever holds the public half, baked in
  // as a constant, matching the ARIA_LICENSE_PUBLIC_X pattern already
  // used for the legacy product's client-side verifier.
  ARIA_ENTITLEMENT_PRIVATE_D: z.string().optional(),
  ARIA_ENTITLEMENT_PUBLIC_X: z.string().optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nCopy .env.example to .env, run `npm run keygen`, and fill in the rest.");
  process.exit(1);
}

export const CONFIG = parsed.data;

if (CONFIG.PUBLIC_URL.endsWith("/")) {
  (CONFIG as any).PUBLIC_URL = CONFIG.PUBLIC_URL.replace(/\/+$/, "");
}

// Fail closed, not silently degrade: webhook mode without a secret would
// accept unauthenticated POSTs claiming to be Telegram — refuse to boot
// rather than run half-configured.
if (CONFIG.TELEGRAM_TRANSPORT === "webhook" && !CONFIG.TELEGRAM_WEBHOOK_SECRET) {
  console.error("❌ TELEGRAM_TRANSPORT=webhook requires TELEGRAM_WEBHOOK_SECRET to be set.");
  process.exit(1);
}

export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";

/** True once Stripe secrets are present — gates the paid-tier endpoints. */
export const PAYMENTS_ENABLED = Boolean(
  CONFIG.STRIPE_SECRET_KEY && CONFIG.STRIPE_WEBHOOK_SECRET,
);

/** True once DATABASE_URL is present — gates the new users/wallet-accounts domain endpoints. */
export const USERS_DOMAIN_ENABLED = Boolean(CONFIG.DATABASE_URL);

/** True once the ARIAE1 signing keypair is configured — gates real entitlement issuance at pairing time. */
export const ENTITLEMENT_ISSUANCE_ENABLED = Boolean(CONFIG.ARIA_ENTITLEMENT_PRIVATE_D && CONFIG.ARIA_ENTITLEMENT_PUBLIC_X);

/**
 * Session B item — version/update enforcement. aria-engine ships from a
 * private git checkout, not a registry with its own update channel — no
 * `npm outdated`-style mechanism exists to query "the latest version" at
 * runtime, so this control plane is the only place a minimum can live.
 * Value matches aria-engine's real current package.json version
 * (0.7.0-beta.4, confirmed via ARIA_VERSION in its src/runtime/doctor.ts)
 * at the time this was written — bump it by hand whenever a new engine
 * release actually requires customers to update, not on every commit.
 * Deliberately exact-string comparison, not semver ordering: this beta
 * ships whole-version bumps, not patch releases where "newer is fine"
 * semantics would matter, and comparing prerelease tags like "beta.4"
 * numerically without a semver library would be more likely to be wrong
 * than an honest "doesn't match" check.
 */
export const MIN_SUPPORTED_ENGINE_VERSION = "0.7.0-beta.4";

export const TIER_LIMITS = {
  // The "trial" key is kept for backward compatibility with the DB and
  // existing issued licenses — it now means "free tier", not a time-limited
  // trial. durationDays is long (not infinite — the token format requires a
  // real expiry) so free licenses effectively don't expire in practice;
  // display copy calls this "FREE", never "TRIAL". Standard/Pro stay defined
  // and dormant below for when paid tiers are actually turned on — removing
  // them would throw away real, tested Stripe integration work for no reason.
  trial: {
    priceId: null as string | null,
    amountUsd: 0,
    durationDays: 3650,
    features: ["paper", "tiered_tp", "trailing_stop", "webhook_alerts"],
    limits: { maxBuySol: 0.02, maxPositions: 5, maxTotalSol: 0.1 },
  },
  standard: {
    priceId: CONFIG.STRIPE_STANDARD_PRICE_ID ?? null,
    amountUsd: 149,
    durationDays: 30,
    features: ["paper", "tiered_tp", "trailing_stop", "webhook_alerts"],
    limits: { maxBuySol: 0.01, maxPositions: 5, maxTotalSol: 0.05 },
  },
  pro: {
    priceId: CONFIG.STRIPE_PRO_PRICE_ID ?? null,
    amountUsd: 449,
    durationDays: 30,
    features: [
      "paper", "tiered_tp", "trailing_stop", "webhook_alerts",
      "custom_strategy", "audit_export",
    ],
    limits: { maxBuySol: 0.05, maxPositions: 10, maxTotalSol: 0.5 },
  },
} as const;

export type Tier = keyof typeof TIER_LIMITS;
