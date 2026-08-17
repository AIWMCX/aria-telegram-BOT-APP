import "dotenv/config";
import { z } from "zod";
import { parseProductRealityConfig, resolveProductReality } from "./product-reality.js";

const Env = z.object({
  // ── Telegram ──────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(20, "TELEGRAM_BOT_TOKEN required (get from @BotFather)"),
  ADMIN_TELEGRAM_CHAT_ID: z.string().optional().default(""),
  PUBLIC_URL: z.string().url("PUBLIC_URL must be a full https:// URL"),

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
  ARIA_ENGINE_CREDENTIAL_PEPPER: z.string().min(32).optional(),
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

/** True once Stripe secrets are present — gates the paid-tier endpoints. */
export const PAYMENTS_ENABLED = Boolean(
  CONFIG.STRIPE_SECRET_KEY && CONFIG.STRIPE_WEBHOOK_SECRET,
);

/**
 * Backend-owned presentation truth. This never authorizes a financial action;
 * unavailable or malformed values fail closed inside the pure resolver.
 */
export const PRODUCT_REALITY = resolveProductReality(
  parseProductRealityConfig(process.env, PAYMENTS_ENABLED),
);

/** True once DATABASE_URL is present — gates the new users/wallet-accounts domain endpoints. */
export const USERS_DOMAIN_ENABLED = Boolean(CONFIG.DATABASE_URL);

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
    features: ["paper", "live", "tiered_tp", "trailing_stop", "webhook_alerts"],
    limits: { maxBuySol: 0.02, maxPositions: 5, maxTotalSol: 0.1 },
  },
  standard: {
    priceId: CONFIG.STRIPE_STANDARD_PRICE_ID ?? null,
    amountUsd: 149,
    durationDays: 30,
    features: ["paper", "live", "tiered_tp", "trailing_stop", "webhook_alerts"],
    limits: { maxBuySol: 0.01, maxPositions: 5, maxTotalSol: 0.05 },
  },
  pro: {
    priceId: CONFIG.STRIPE_PRO_PRICE_ID ?? null,
    amountUsd: 449,
    durationDays: 30,
    features: [
      "paper", "live", "tiered_tp", "trailing_stop", "webhook_alerts",
      "jito_bundles", "custom_strategy", "audit_export",
    ],
    limits: { maxBuySol: 0.05, maxPositions: 10, maxTotalSol: 0.5 },
  },
} as const;

export type Tier = keyof typeof TIER_LIMITS;
