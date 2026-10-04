/**
 * Central, pure secret redaction for anything that reaches a log line.
 *
 * Applied once at the logger boundary (src/logger.ts) so no call site has to
 * remember to scrub. Never throws; safe on circular graphs and non-string
 * input. Pure: runtime secret values are passed in, not read from CONFIG.
 *
 * Origin: 2026-09-26 audit J-1 — a failed setWebhook put grammY's
 * `err.payload` (including `secret_token`) into a log line.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /^(secret_token|authorization|x-telegram-bot-api-secret-token)$|private|(^|[_-])d$/i;
const BOT_TOKEN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;
// "secret_token":"..."  |  secret_token=...  |  Authorization: Bearer ...
const KEYED_JSON = /("(?:secret_token|authorization|x-telegram-bot-api-secret-token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const KEYED_PAIR = /\b(secret_token|x-telegram-bot-api-secret-token)(\s*[=:]\s*)[^\s,;&"'}]+/gi;
const AUTH_HEADER = /\b(authorization\s*[=:]\s*)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi;
const PRIVATE_PAIR = /\b([A-Za-z0-9_]*(?:PRIVATE_D|_D)\s*[=:]\s*)[^\s,;"'}]+/g;

const MAX_DEPTH = 12;

/** Env var names whose current runtime values must never be logged. */
export const SECRET_ENV_NAMES = [
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "ARIA_LICENSE_PRIVATE_D",
  "ARIA_ENTITLEMENT_PRIVATE_D",
] as const;

/** Collect non-empty current values of the secret env vars from a source. */
export function collectSecretValues(src: Record<string, unknown>): string[] {
  const names = new Set<string>(SECRET_ENV_NAMES);
  for (const k of Object.keys(src)) if (/^ARIA_.*_PRIVATE_D$/.test(k)) names.add(k);
  const out: string[] = [];
  for (const n of names) {
    const v = src[n];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

export function redactString(input: string, secrets: readonly string[] = []): string {
  let s = input;
  // Longest first so a secret that contains another is masked fully.
  for (const sec of [...secrets].filter((x) => typeof x === "string" && x.length > 0).sort((a, b) => b.length - a.length)) {
    s = s.split(sec).join(REDACTED);
  }
  return s
    .replace(KEYED_JSON, `$1"${REDACTED}"`)
    .replace(KEYED_PAIR, `$1$2${REDACTED}`)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(PRIVATE_PAIR, `$1${REDACTED}`)
    .replace(BOT_TOKEN, REDACTED);
}

/**
 * Returns a redacted deep copy of any value (strings, objects, arrays,
 * Errors incl. cause chains). Errors become plain objects so message, stack
 * and own enumerable fields (e.g. grammY `payload`, `error`) are all scrubbed.
 */
export function redactSecrets(value: unknown, secrets: readonly string[] = []): unknown {
  try {
    return walk(value, secrets, new WeakMap(), 0);
  } catch {
    return "[UNREDACTABLE]";
  }
}

function walk(v: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>, depth: number): unknown {
  if (typeof v === "string") return redactString(v, secrets);
  if (v === null || typeof v !== "object") {
    if (typeof v === "function" || typeof v === "symbol") return String(typeof v);
    return typeof v === "bigint" ? v.toString() : v;
  }
  if (seen.has(v)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";

  if (Array.isArray(v)) {
    const arr: unknown[] = [];
    seen.set(v, arr);
    for (const item of v) arr.push(walk(item, secrets, seen, depth + 1));
    return arr;
  }
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return REDACTED;

  const out: Record<string, unknown> = {};
  seen.set(v, out);
  if (v instanceof Error) {
    out.type = v.constructor?.name ?? "Error";
    out.message = walk(v.message, secrets, seen, depth + 1);
    out.stack = walk(v.stack, secrets, seen, depth + 1);
    if ("cause" in v && (v as { cause?: unknown }).cause !== undefined) {
      out.cause = walk((v as { cause?: unknown }).cause, secrets, seen, depth + 1);
    }
  }
  for (const key of Object.keys(v)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    let child: unknown;
    try {
      child = (v as Record<string, unknown>)[key];
    } catch {
      child = "[UNREADABLE]";
    }
    out[key] = walk(child, secrets, seen, depth + 1);
  }
  return out;
}
