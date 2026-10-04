/**
 * Central, pure secret redaction for anything that reaches a log line.
 *
 * Applied once at the logger boundary (src/logger.ts) so no call site has to
 * remember to scrub. Never throws; safe on circular graphs and non-string
 * input. Pure: runtime secret values are passed in, not read from CONFIG.
 *
 * Origin: 2026-09-26 audit J-1 — a failed setWebhook put grammY's
 * `err.payload` (including `secret_token`) into a log line.
 *
 * REGEX SAFETY: every pattern here runs on attacker-influenced strings (e.g.
 * User-Agent). All are anchored/bounded to be linear; test/log-redaction.ts
 * feeds adversarial inputs under a time bound. Do not add unanchored `\d+`
 * style patterns.
 */
export const REDACTED = "[REDACTED]";
const MIN_ENV_SECRET_LEN = 8; // shorter values would mangle ordinary text

// Normalised (lowercase, alphanumerics only) key names that are always masked.
const SENSITIVE_KEYS = new Set([
  "secrettoken", "xtelegrambotapisecrettoken", "authorization", "proxyauthorization",
  "apikey", "xapikey", "password", "passwd", "pwd", "token", "accesstoken", "refreshtoken",
  "idtoken", "bearer", "cookie", "setcookie", "secret", "clientsecret", "d", "privatekey",
  "databaseurl", "connectionstring",
]);
function isSensitiveKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEYS.has(n)) return true;
  // e.g. TELEGRAM_WEBHOOK_SECRET, stripeApiKey, ARIA_X_PRIVATE_D, dbPassword.
  // "tokenCount"/"secretsFound" intentionally do NOT match (suffix only).
  return /private/.test(n) || /(secret|password|apikey|secrettoken|accesstoken)$/.test(n);
}

// Telegram bot token. Left-anchored with a digit lookbehind and bounded
// quantifiers: without the lookbehind a long digit run is O(n^2) (ReDoS).
const BOT_TOKEN = /(?<!\d)\d{6,15}:[A-Za-z0-9_-]{30,64}/g;
// "secret_token":"..." (JSON text)
const KEYED_JSON = /("(?:secret_token|authorization|x-telegram-bot-api-secret-token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const KEYED_PAIR = /\b(secret_token|x-telegram-bot-api-secret-token)(\s*[=:]\s*)[^\s,;&"'}]+/gi;
const AUTH_HEADER = /\b(authorization\s*[=:]\s*)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi;
const PRIVATE_PAIR = /\b([A-Za-z0-9_]{0,64}(?:PRIVATE_D|_D)\s*[=:]\s*)[^\s,;"'}]+/g;
// scheme://user:PASS@host  ->  scheme://user:[REDACTED]@host (password may hold '#', '/', etc.)
const URL_CREDS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"']{0,256}:)[^\s@]{1,1024}@/gi;

const MAX_DEPTH = 12;

/** Env var names whose current runtime values must never be logged. */
export const SECRET_ENV_NAMES = [
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "DATABASE_URL",
  "ARIA_LICENSE_PRIVATE_D",
  "ARIA_ENTITLEMENT_PRIVATE_D",
] as const;

function variants(v: string): string[] {
  const out = new Set<string>([v]);
  try { out.add(encodeURIComponent(v)); } catch { /* lone surrogate */ }
  out.add(JSON.stringify(v).slice(1, -1)); // JSON-escaped form
  return [...out];
}

/** Collect live secret values (and encoded forms) from an env-like source. */
export function collectSecretValues(src: Record<string, unknown>): string[] {
  const names = new Set<string>(SECRET_ENV_NAMES);
  for (const k of Object.keys(src)) if (/^ARIA_.*_PRIVATE_D$/.test(k)) names.add(k);
  const out = new Set<string>();
  for (const n of names) {
    const v = src[n];
    if (typeof v !== "string" || v.length < MIN_ENV_SECRET_LEN) continue;
    for (const x of variants(v)) out.add(x);
    if (n === "DATABASE_URL") {
      // Also the bare password (even if malformed/unencoded).
      const at = v.lastIndexOf("@");
      const m = /^[a-z][a-z0-9+.-]*:\/\/[^:/@]*:/i.exec(v);
      if (m && at > m[0].length) {
        const pw = v.slice(m[0].length, at);
        if (pw.length >= MIN_ENV_SECRET_LEN) for (const x of variants(pw)) out.add(x);
      }
    }
  }
  return [...out];
}

export function redactString(input: string, secrets: readonly string[] = []): string {
  let s = input;
  // Longest first so a secret that contains another is masked fully.
  for (const sec of [...secrets].filter((x) => typeof x === "string" && x.length >= MIN_ENV_SECRET_LEN).sort((a, b) => b.length - a.length)) {
    s = s.split(sec).join(REDACTED);
  }
  return s
    .replace(URL_CREDS, `$1${REDACTED}@`)
    .replace(KEYED_JSON, `$1"${REDACTED}"`)
    .replace(KEYED_PAIR, `$1$2${REDACTED}`)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(PRIVATE_PAIR, `$1${REDACTED}`)
    .replace(BOT_TOKEN, REDACTED);
}

/**
 * Returns a redacted deep copy of any value (strings, objects, arrays,
 * Errors incl. cause chains). Errors become plain objects so message, stack
 * and own enumerable fields (e.g. grammY `payload`, `error`, Node's
 * ERR_INVALID_URL `input`) are all scrubbed.
 */
export function redactSecrets(value: unknown, secrets: readonly string[] = []): unknown {
  try {
    return walk(value, secrets, new WeakSet(), 0);
  } catch {
    return "[UNREDACTABLE]";
  }
}

function walk(v: unknown, secrets: readonly string[], ancestors: WeakSet<object>, depth: number): unknown {
  if (typeof v === "string") return redactString(v, secrets);
  if (v === null || typeof v !== "object") {
    if (typeof v === "function" || typeof v === "symbol") return String(typeof v);
    return typeof v === "bigint" ? v.toString() : v;
  }
  if (ArrayBuffer.isView(v)) return `[BINARY ${v.byteLength} bytes]`;
  if (v instanceof ArrayBuffer) return `[BINARY ${v.byteLength} bytes]`;
  if (ancestors.has(v)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (v instanceof Date) return v.toISOString();

  ancestors.add(v);
  try {
    if (Array.isArray(v)) return v.map((item) => walk(item, secrets, ancestors, depth + 1));
    const out: Record<string, unknown> = {};
    if (v instanceof Error) {
      out.type = v.constructor?.name ?? "Error";
      out.message = walk(v.message, secrets, ancestors, depth + 1);
      out.stack = walk(v.stack, secrets, ancestors, depth + 1);
      if ("cause" in v && (v as { cause?: unknown }).cause !== undefined) {
        out.cause = walk((v as { cause?: unknown }).cause, secrets, ancestors, depth + 1);
      }
    }
    for (const key of Object.keys(v)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      let child: unknown;
      try {
        child = (v as Record<string, unknown>)[key];
      } catch {
        child = "[UNREADABLE]";
      }
      out[key] = walk(child, secrets, ancestors, depth + 1);
    }
    return out;
  } finally {
    ancestors.delete(v);
  }
}
