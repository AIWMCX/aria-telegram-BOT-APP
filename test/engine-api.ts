import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = "d".repeat(43);
process.env.ARIA_LICENSE_PUBLIC_X = "x".repeat(43);
const { app } = await import("../src/server.js");
const { signEngineRequest, verifySignedRequest } = await import("../src/engine-auth.js");

function initData(userId: number): string {
  const params = new URLSearchParams({ user: JSON.stringify({ id: userId, first_name: "Test" }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const pairs = Array.from(params.keys()).sort().map((key) => `${key}=${params.get(key)}`);
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN!).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex"));
  return params.toString();
}

assert.equal((await app.request("/api/engine/devices")).status, 400);
assert.equal((await app.request("/api/engine/devices", { headers: { "x-init-data": "forged" } })).status, 401);
assert.equal((await app.request("/api/engine/pairing", { method: "POST", headers: { "x-init-data": initData(1) } })).status, 503);
assert.equal((await app.request("/api/engine/pairing/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "a".repeat(16) }) })).status, 503);
assert.equal((await app.request("/api/engine/heartbeat", { method: "POST", body: "{}" })).status, 401);
assert.equal((await app.request("/api/engine/commands", { headers: { "x-engine-credential": "bad" } })).status, 401);
const signed = signEngineRequest("credential-value-123456", "POST", "/api/engine/heartbeat", "{}", Date.now(), "nonce-value-123456");
assert.notEqual(verifySignedRequest(new Headers(signed), "POST", "/api/engine/heartbeat", "{}"), null);
assert.equal(verifySignedRequest(new Headers(signed), "POST", "/api/engine/heartbeat", "{\"tampered\":true}"), null);
console.log("engine API auth boundary tests passed");
