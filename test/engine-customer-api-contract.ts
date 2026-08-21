/**
 * REAL-1 preview contract for the customer-facing engine API.
 *
 * This suite deliberately runs WITHOUT DATABASE_URL. It verifies that
 * Telegram authentication is enforced before any Postgres access and that
 * the routes exist and fail closed when the users/device domain is absent.
 * Real ownership/snapshot/command persistence is verified separately by the
 * Railway Postgres self-test before preview promotion.
 */
import crypto, { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string; x: string };
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };

process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = privJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = pubJwk.x;
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;
process.env.DB_PATH = "./data/engine-customer-api-contract.db";
process.env.LOG_LEVEL = "error";
delete process.env.DATABASE_URL;

const { app } = await import("../src/server.js");
await import("../src/engine-customer-routes.js");
const { CONFIG } = await import("../src/config.js");

function buildInitData(user: object): string {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  const pairs = Array.from(params.keys()).sort().map((k) => `${k}=${params.get(k)}`);
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(CONFIG.TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const forged = "user=" + encodeURIComponent(JSON.stringify({ id: 1, first_name: "Attacker" })) +
  "&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=" + "0".repeat(64);
const validInitData = buildInitData({ id: 777001, first_name: "Preview", username: "preview_user" });

const missingState = await app.request("/api/engine/me", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
});
check("POST /api/engine/me exists and missing initData -> 400", missingState.status === 400);

const forgedState = await app.request("/api/engine/me", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: forged }),
});
check("POST /api/engine/me rejects forged Telegram identity -> 401", forgedState.status === 401);

const noDbState = await app.request("/api/engine/me", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData }),
});
check("POST /api/engine/me fails closed without Postgres -> 503", noDbState.status === 503);

const badCommand = await app.request("/api/engine/command", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ initData: validInitData, command: "live_buy" }),
});
check("POST /api/engine/command rejects non-paper command -> 400", badCommand.status === 400);

const forgedCommand = await app.request("/api/engine/command", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ initData: forged, command: "paper_stop" }),
});
check("POST /api/engine/command rejects forged Telegram identity -> 401", forgedCommand.status === 401);

const noDbStop = await app.request("/api/engine/command", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ initData: validInitData, command: "paper_stop" }),
});
check("POST /api/engine/command exists and fails closed without Postgres -> 503", noDbStop.status === 503);

console.log(`\n${failures === 0 ? "✅ ENGINE CUSTOMER API CONTRACT PASSED" : `❌ ${failures} ENGINE CUSTOMER API CONTRACT FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
