/**
 * Proves the logger boundary redacts secrets and emits real severities.
 * Dummy secret values only. Run: npx tsx test/log-redaction.ts
 */
import fs from "node:fs";

const TEST_DB = "./data/log-redaction-test.db";
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);

const WH = "TEST_SECRET_VALUE_123";
const BOT = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
const STRIPE = "sk_test_DUMMYSTRIPEKEY0001";
const STRIPE_WH = "whsec_DUMMYSTRIPEWH0001";
const RESEND = "re_DUMMYRESENDKEY0001";
const LIC_D = "DUMMY_LICENSE_PRIVATE_D_VALUE_0001";
const ENT_D = "DUMMY_ENTITLEMENT_PRIVATE_D_VALUE_0001";

process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.TELEGRAM_WEBHOOK_SECRET = WH;
process.env.STRIPE_SECRET_KEY = STRIPE;
process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WH;
process.env.RESEND_API_KEY = RESEND;
process.env.ARIA_LICENSE_PRIVATE_D = LIC_D;
process.env.ARIA_ENTITLEMENT_PRIVATE_D = ENT_D;
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PUBLIC_X = "DUMMY_PUBLIC_X_VALUE_0000000000";
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(ok ? `✅ ${name}` : `❌ ${name}`);
  if (!ok) failures++;
}

const ALL = [WH, BOT, STRIPE, STRIPE_WH, RESEND, LIC_D, ENT_D];
const leaks = (s: string) => ALL.filter((v) => s.includes(v));

async function main() {
  const { redactSecrets, redactString, collectSecretValues } = await import("../src/redact.js");
  const { createLogger } = await import("../src/logger.js");
  const secrets = collectSecretValues(process.env);
  const ser = (v: unknown) => JSON.stringify(redactSecrets(v, secrets));

  // ── env-value redaction, every category, in plain strings ──
  for (const [n, v] of [["webhook secret", WH], ["bot token", BOT], ["stripe key", STRIPE], ["stripe webhook", STRIPE_WH], ["resend", RESEND], ["license D", LIC_D], ["entitlement D", ENT_D]] as const) {
    check(`string: ${n} masked`, !String(redactSecrets(`boom ${v} boom`, secrets)).includes(v));
  }
  check("empty secret values skipped (no mangling)", redactString("hello world", ["", "x".repeat(0)]) === "hello world");

  // ── pattern-based (value NOT in env) ──
  const foreignTok = "9876543210:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij_-";
  check("pattern: telegram bot token", !String(redactSecrets(`url /bot${foreignTok}/setWebhook`, secrets)).includes(foreignTok));
  check("pattern: JSON secret_token in string", !String(redactSecrets('{"url":"x","secret_token":"FOREIGN_SECRET_999"}', secrets)).includes("FOREIGN_SECRET_999"));
  check("pattern: secret_token=… pair", !String(redactSecrets("secret_token=FOREIGN_SECRET_999&x=1", secrets)).includes("FOREIGN_SECRET_999"));
  check("pattern: Authorization header string", !String(redactSecrets("Authorization: Bearer FOREIGN_BEARER_999", secrets)).includes("FOREIGN_BEARER_999"));
  check("pattern: X-Telegram-Bot-Api-Secret-Token header", !String(redactSecrets("x-telegram-bot-api-secret-token: FOREIGN_HDR_999", secrets)).includes("FOREIGN_HDR_999"));
  check("pattern: ARIA_*_PRIVATE_D=… pair", !String(redactSecrets("ARIA_OTHER_PRIVATE_D=FOREIGN_D_999", secrets)).includes("FOREIGN_D_999"));

  // ── key-name masking in objects, nested ──
  const o = ser({ a: { b: [{ secret_token: "FOREIGN_A", authorization: "FOREIGN_B", "x-telegram-bot-api-secret-token": "FOREIGN_C", privateKey: "FOREIGN_D", d: "FOREIGN_E", ARIA_X_PRIVATE_D: "FOREIGN_F" }] } });
  check("object keys: all sensitive keys masked, nested", !/FOREIGN_[A-F]/.test(o));
  check("object: benign fields preserved", ser({ ok: "visible", n: 5 }).includes("visible"));

  // ── Error message/stack/nested/cause ──
  const e = new Error(`failed with ${WH}`, { cause: new Error(`inner ${STRIPE}`) });
  const es = ser(e);
  check("Error.message masked", !es.includes(WH));
  check("Error.stack masked (stack embeds message)", leaks(JSON.stringify((redactSecrets(e, secrets) as { stack: string }).stack)).length === 0);
  check("Error.cause chain kept AND masked", es.includes("inner") && !es.includes(STRIPE));
  check("Error has type/message kept", es.includes('"message"'));

  // ── circular / non-string / hostile input never throws ──
  const circ: Record<string, unknown> = { name: "c", tok: WH };
  circ.self = circ;
  let threw = false;
  let cs = "";
  try { cs = ser(circ); } catch { threw = true; }
  check("circular object: no throw", !threw);
  check("circular object: still masked", !cs.includes(WH));
  try { for (const x of [undefined, null, 42, 10n, Symbol("s"), () => 1, NaN]) redactSecrets(x, secrets); } catch { threw = true; }
  check("non-string inputs: no throw", !threw);
  const hostile = { get boom(): string { throw new Error("getter"); } };
  try { redactSecrets(hostile, secrets); } catch { threw = true; }
  check("throwing getter: no throw", !threw);

  // ── realistic failed-setWebhook (grammY-style) through the real logger ──
  class GrammyLikeError extends Error {
    constructor(public method: string, public payload: unknown, public error_code: number, public description: string) {
      super(`Call to '${method}' failed! (${error_code}: ${description})`);
      this.name = "GrammyError";
    }
  }
  const lines: string[] = [];
  const sink = { write: (s: string) => { lines.push(s); } };
  const log = createLogger(sink, "trace");
  const gerr = new GrammyLikeError("setWebhook", { url: "https://x.example/api/telegram/webhook", secret_token: WH }, 429, "Too Many Requests: retry after 1");
  (gerr as unknown as { cause: unknown }).cause = new Error(`req body {"secret_token":"${WH}"} to /bot${BOT}/setWebhook`);
  log.error({ err: gerr }, "TELEGRAM_WEBHOOK_REASSERT_FAILED");
  const out = lines.join("");
  check("setWebhook failure log: contains the event", out.includes("TELEGRAM_WEBHOOK_REASSERT_FAILED"));
  check("setWebhook failure log: error_code/description retained", out.includes("429") && out.includes("Too Many Requests"));
  check("setWebhook failure log: NO secret values anywhere", leaks(out).length === 0);
  log.info(`token ${BOT} ws ${WH}`);
  check("plain message string through logger masked", leaks(lines.join("")).length === 0);

  const envOnly: string[] = [];
  const log4 = createLogger({ write: (s: string) => { envOnly.push(s); } }, "trace");
  log4.error({ detail: `provider said bad key ${RESEND}` }, `stripe ${STRIPE_WH} failed`);
  check("env-value-only secrets masked via logger (no pattern help)", leaks(envOnly.join("")).length === 0 && envOnly.join("").includes("provider said bad key"));

  // ── severity ──
  const sev: string[] = [];
  const log2 = createLogger({ write: (s: string) => { sev.push(s); } }, "trace");
  log2.error("e"); log2.warn("w"); log2.info("i");
  const parsed = sev.map((s) => JSON.parse(s) as { level: unknown; severity: unknown });
  check("severity: error line has string level+severity 'error'", parsed[0].level === "error" && parsed[0].severity === "error");
  check("severity: warn line is 'warn'", parsed[1].level === "warn" && parsed[1].severity === "warn");
  check("severity: info line is 'info'", parsed[2].level === "info" && parsed[2].severity === "info");
  const sev2: string[] = [];
  const log3 = createLogger({ write: (s: string) => { sev2.push(s); } }, "error");
  log3.info("hidden"); log3.warn("hidden"); log3.error("shown");
  check("LOG_LEVEL threshold still honoured", sev2.length === 1 && sev2[0].includes("shown"));

  // webhook mismatch is warn, reassert failure is error (source contract)
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  check("index.ts: MISMATCH logged at warn", /logger\.warn\(\s*\{ expectedUrl[\s\S]*?TELEGRAM_WEBHOOK_MISMATCH/.test(src));
  check("index.ts: REASSERT_FAILED logged at error", /logger\.error\(\{ err \}, "TELEGRAM_WEBHOOK_REASSERT_FAILED"\)/.test(src));

  for (const sfx of ["", "-wal", "-shm"]) if (fs.existsSync(TEST_DB + sfx)) fs.rmSync(TEST_DB + sfx);
  console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
