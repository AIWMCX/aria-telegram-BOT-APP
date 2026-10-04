/**
 * Proves license/entitlement bearer tokens (ARIA1. / ARIAE1.) never reach a log
 * line, including via a failed grammY sendMessage. Tokens are minted by the REAL
 * signer functions with a throwaway in-process Ed25519 keypair (never real keys).
 * Run: npx tsx test/token-redaction.ts
 */
import { generateKeyPairSync } from "node:crypto";

const lic = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { d: string; x: string };
const ent = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as { d: string; x: string };
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.TELEGRAM_WEBHOOK_SECRET = "TEST_SECRET_VALUE_123";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = lic.d;
process.env.ARIA_LICENSE_PUBLIC_X = lic.x;
process.env.ARIA_ENTITLEMENT_PRIVATE_D = ent.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = ent.x;
process.env.DB_PATH = "./data/token-redaction-test.db";
process.env.RESEND_API_KEY = "re_DUMMYRESENDKEY0001";
process.env.STRIPE_SECRET_KEY = "sk_test_DUMMYSTRIPEKEY0001";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_DUMMYSTRIPEWH0001";
process.env.LOG_LEVEL = "error";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(ok ? `PASS ${name}` : `FAIL ${name}`);
  if (!ok) failures++;
}

async function main() {
  const { signLicense } = await import("../src/license-signer.js");
  const { issueReal1BetaEntitlementToken } = await import("../src/engine-entitlement-signer.js");
  const { redactSecrets, redactString } = await import("../src/redact.js");
  const { createLogger } = await import("../src/logger.js");
  const { GrammyError } = await import("grammy");

  const now = Math.floor(Date.now() / 1000);
  const LIC = signLicense({
    v: 1, iss: "aria", sub: "lead_1", email: "a@example.com", tg_user_id: 1, wallet: "W".repeat(44), tier: "pro",
    features: ["a", "b"], limits: { maxBuySol: 1, maxPositions: 2, maxTotalSol: 3 }, iat: now, exp: now + 1000, jti: "lic_abc123def456",
  });
  const ENT = issueReal1BetaEntitlementToken("client-1", "ent_1").token;
  check("dummy license has ARIA1. format", /^ARIA1\.[\w-]+\.[\w-]+$/.test(LIC));
  check("dummy entitlement has ARIAE1. format", /^ARIAE1\.[\w-]+\.[\w-]+$/.test(ENT));
  // body = everything after the tag; must never survive
  const body = (t: string) => t.slice(t.indexOf(".") + 1);
  const leaked = (out: string) => [LIC, ENT].some((t) => out.includes(body(t)) || out.includes(t.split(".")[2]!));

  // Pattern-only: no secrets list is passed, so ONLY the token pattern can help.
  const ser = (v: unknown) => JSON.stringify(redactSecrets(v, []));

  check("plain string: license masked, tag kept", (() => { const o = redactString(`k=${LIC} done`); return !leaked(o) && o.includes("ARIA1.[REDACTED] done"); })());
  check("plain string: entitlement masked, tag kept", (() => { const o = redactString(`x ${ENT}`); return !leaked(o) && o.includes("ARIAE1.[REDACTED]"); })());
  check("nested object value", !leaked(ser({ a: { b: [{ note: `key:\`${LIC}\`` }, ENT] } })));
  check("truncated token (no signature) masked", !redactString(`t ${LIC.slice(0, LIC.lastIndexOf("."))}`).includes(body(LIC).split(".")[0]!));

  // Error.message / stack / cause
  const e = new Error(`send failed for ${LIC}`, { cause: new Error(`inner ${ENT}`) });
  const es = ser(e);
  check("Error.message + stack + cause masked", !leaked(es) && es.includes("inner"));

  // Real failed sendMessage GrammyError: payload carries the full text.
  const text = ["*Advanced: raw license key*", "", `\`${LIC}\``, "", "Paste into .env"].join("\n");
  const ge = new GrammyError("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities)",
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, "sendMessage", { chat_id: 1, text, parse_mode: "Markdown" });
  check("GrammyError payload.text carries token (precondition)", JSON.stringify({ p: ge.payload }).includes(body(LIC).slice(0, 30)));
  check("GrammyError through redactSecrets masked", !leaked(ser(ge)));
  const lines: string[] = [];
  createLogger({ write: (s: string) => { lines.push(s); } }, "trace").error({ err: ge }, `bot error ${ENT}`);
  check("GrammyError through logger masked", !leaked(lines.join("")) && lines.join("").includes("sendMessage"));

  // Handler layer: only diagnostic fields are logged for failed sends.
  const { describeBotError } = await import("../src/bot.js");
  const d = JSON.stringify(describeBotError(ge));
  check("describeBotError keeps method/code/description only", d.includes("sendMessage") && d.includes("400") && d.includes("parse entities") && !d.includes("ARIA1") && !d.includes("payload"));
  check("describeBotError passes non-Grammy errors through", describeBotError(new Error("x")) instanceof Error);

  // Over-cap token: payload > 16384 and a long signature tail must be fully masked.
  const bigLic = signLicense({
    v: 1, iss: "aria", sub: "lead_1", email: "x".repeat(13000) + "@e.com", tg_user_id: 1, wallet: "W".repeat(44), tier: "pro",
    features: ["a"], limits: { maxBuySol: 1, maxPositions: 2, maxTotalSol: 3 }, iat: now, exp: now + 1000, jti: "lic_big000000001",
  });
  const [bTag, bPay, bSig] = bigLic.split(".") as [string, string, string];
  check("over-cap precondition: payload > 16384", bPay.length > 16384);
  const bigOut = redactString("log " + bigLic + " end");
  check("over-cap token fully masked (no payload/sig remnants)", bigOut === "log " + bTag + ".[REDACTED] end" || bigOut === "log " + bTag + ".[REDACTED]");
  check("over-cap token: signature never survives", !bigOut.includes(bSig.slice(0, 20)) && !bigOut.includes(bPay.slice(-20)));
  const forcedTail = "ARIA1." + "a".repeat(16384) + "TAILPAYLOAD." + "s".repeat(1024) + "TAILSIGNATURE";
  check("synthetic over-cap tails masked", !/TAIL/.test(redactString("k=" + forcedTail)));

  // Pairing codes: aria pair <27-char base64url>, MarkdownV2-escaped in bot text.
  const { randomBytes } = await import("node:crypto");
  const code = "Zq7Kx9PwLm" + randomBytes(20).toString("base64url").slice(0, 14) + "_-9"; // 27 chars incl. _ and -
  const escCode = code.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
  const pairText = ["*Pair your ARIA device*", "", "`aria pair " + escCode + "`", "Expires 12:00 UTC"].join("\n");
  const pleak = (o: string) => o.includes(code.slice(0, 10)) || o.includes(code.slice(-8)) || o.includes(escCode.slice(-8));
  check("pair code: plain string masked, marker kept", (() => { const o = redactString(pairText); return !pleak(o) && o.includes("aria pair [REDACTED]") && o.includes("Expires 12:00 UTC"); })());
  check("pair code: unescaped + /pair form masked", !pleak(redactString("run aria pair " + code)) && !pleak(redactString("/pair " + code)));
  check("pair code: nested object", !pleak(ser({ a: [{ note: pairText }] })));
  const pge = new GrammyError("Call to 'sendMessage' failed! (400: Bad Request: can't parse entities)",
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, "sendMessage", { chat_id: 1, text: pairText, parse_mode: "Markdown" });
  check("pair code GrammyError precondition: payload carries code", JSON.stringify(pge.payload).includes(code.slice(0, 10)));
  check("pair code: GrammyError via redactSecrets masked", !pleak(ser(pge)));
  const plines: string[] = [];
  createLogger({ write: (s: string) => { plines.push(s); } }, "trace").error({ err: pge }, "pair command failed");
  check("pair code: GrammyError via logger masked", !pleak(plines.join("")));
  check("pair code: describeBotError drops payload", !pleak(JSON.stringify(describeBotError(pge))));
  const lines2: string[] = [];
  createLogger({ write: (s: string) => { lines2.push(s); } }, "trace").error({ err: describeBotError(pge) }, "pair command failed");
  check("pair code: handler-layer log has no code", !pleak(lines2.join("")));

  // parameters: retry_after / migrate_to_chat_id kept (non-secret), nothing else.
  const rl = new GrammyError("Call to 'sendMessage' failed! (429)",
    { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7, migrate_to_chat_id: -100123 } },
    "sendMessage", { chat_id: 1, text: pairText });
  const rd = describeBotError(rl) as Record<string, unknown>;
  check("describeBotError keeps retry_after + migrate_to_chat_id", rd.retry_after === 7 && rd.migrate_to_chat_id === -100123 && !JSON.stringify(rd).includes("aria pair"));

  // Timing: 100KB adversarial inputs
  const adv: Array<[string, string]> = [
    ["100k b64 chars after tag", "ARIA1." + "a".repeat(100_000)],
    ["repeated tags", "ARIA1.".repeat(16_666)],
    ["repeated tag+short seg", "ARIAE1.aa.".repeat(10_000)],
    ["tag + 100k dots", "ARIA1" + ".".repeat(100_000)],
    ["tag-prefix soup", "ARIAE".repeat(20_000)],
    ["tag + payload + 100k sig", "ARIAE1.abc." + "b".repeat(100_000)],
    ["many ARIA1 no dot", "ARIA1".repeat(20_000)],
    ["pair prefix soup", "aria pair ".repeat(20_000)],
    ["pair + 100k code chars", "aria pair " + "a".repeat(100_000)],
    ["pair + backslash soup", "aria pair " + "\\".repeat(100_000)],
    ["pair + backslash/char alternation", "aria pair " + "\\a".repeat(50_000)],
    ["slash-pair soup", "/pair ".repeat(20_000)],
    ["alternating tag/long seg", ("ARIA1." + "c".repeat(20_000) + " ").repeat(5)],
  ];
  let worst = 0, worstName = "";
  for (const [n, s] of adv) {
    const t0 = performance.now();
    redactSecrets({ ua: s }, []);
    const dt = performance.now() - t0;
    if (dt > worst) { worst = dt; worstName = n; }
  }
  console.log(`   (slowest adversarial input: ${worstName} ${worst.toFixed(1)}ms)`);
  check("ReDoS: 100KB adversarial token inputs <100ms each", worst < 100);
  const big: Array<[string, string]> = [
    ["1MB token chars", "ARIA1." + "a".repeat(1 << 20)],
    ["1MB token dotted", "ARIA1." + "a.".repeat(1 << 19)],
    ["1MB repeated tags", "ARIAE1.a.".repeat(116_000)],
    ["1MB pair code chars", "aria pair " + "a".repeat(1 << 20)],
    ["1MB pair backslash/char", "aria pair " + "\\a".repeat(350_000)],
    ["1MB repeated pair", "aria pair a ".repeat(87_000)],
  ];
  let bw = 0, bn = "";
  for (const [n, s2] of big) { const t0 = performance.now(); redactString(s2); const dt = performance.now() - t0; if (dt > bw) { bw = dt; bn = n; } }
  console.log("   (slowest 1MB input: " + bn + " " + bw.toFixed(1) + "ms)");
  check("ReDoS: 1MB adversarial inputs <500ms each", bw < 500);

  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nAll token-redaction checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
