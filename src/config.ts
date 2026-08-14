import "dotenv/config";
import { z } from "zod";

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

export const TIER_LIMITS = {
  trial: {
    priceId: null as string | null,
    amountUsd: 0,
    durationDays: 7,
    features: ["paper", "tiered_tp"],
    limits: { maxBuySol: 0.005, maxPositions: 3, maxTotalSol: 0.015 },
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
