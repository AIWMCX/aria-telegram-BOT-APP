import assert from "node:assert/strict";
import crypto from "node:crypto";

const required = ["DATABASE_URL", "REAL1_RPC_URL", "REAL1_PUBLIC_ADDRESS", "ARIA_ENGINE_CREDENTIAL_PEPPER"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`REAL1_SMOKE_BLOCKED missing: ${missing.join(", ")}`);
  process.exitCode = process.env.CI === "true" ? 1 : 2;
} else {
  process.env.TELEGRAM_BOT_TOKEN ??= "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
  process.env.PUBLIC_URL ??= "https://example.com";
  process.env.RESEND_API_KEY ??= "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
  process.env.ADMIN_EMAIL ??= "admin@example.com";
  process.env.ARIA_LICENSE_PRIVATE_D ??= "d".repeat(43);
  process.env.ARIA_LICENSE_PUBLIC_X ??= "x".repeat(43);
  process.env.ARIA_NETWORK_MODE ??= "solana-devnet";
  process.env.ARIA_ENGINE_MODE ??= "paper";

  const { app } = await import("../src/server.js");
  const { Engine } = await import("../engine/src/engine.js");
  const { SolanaRpc } = await import("../engine/src/rpc.js");
  const { signEngineRequest } = await import("../engine/src/protocol.js");
  const userId = 909090909;
  const initParams = new URLSearchParams({ user: JSON.stringify({ id: userId, first_name: "REAL1Smoke" }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const pairs = Array.from(initParams.keys()).sort().map((key) => `${key}=${initParams.get(key)}`);
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN!).digest();
  initParams.set("hash", crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex"));
  const initData = initParams.toString();
  const auth = await app.request("/api/auth/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) });
  assert.equal(auth.status, 200, "PostgreSQL users domain must be available");
  const pairing = await app.request("/api/engine/pairing", { method: "POST", headers: { "x-init-data": initData } });
  assert.equal(pairing.status, 200, "pairing must be available after identity creation");
  const pairingBody = await pairing.json() as { pairingCode: string };
  const exchanged = await app.request("/api/engine/pairing/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairingBody.pairingCode }) });
  assert.equal(exchanged.status, 200);
  const credentialBody = await exchanged.json() as { deviceId: string; credential: string };

  const rpc = new SolanaRpc(process.env.REAL1_RPC_URL!, "solana-devnet");
  const strategy = { buyAmountSol: 0.01, maxPositions: 1, maxSlippageBps: 200, stopLossPct: 20, takeProfit1Pct: 80, takeProfit2Pct: 200, trailingStopPct: 10, minimumLiquiditySol: 500, maximumTokenAgeSeconds: 300, safetyFilters: { requireRevokedAuthorities: true, requireSocials: true } };
  const engine = new Engine({ rpc, publicAddress: process.env.REAL1_PUBLIC_ADDRESS!, strategy, license: () => "valid" });
  await engine.start();
  assert.equal(engine.snapshot().status, "paper_running");
  const heartbeatBody = JSON.stringify({ engineVersion: "0.1.0", state: engine.snapshot() });
  const heartbeat = await app.request("/api/engine/heartbeat", { method: "POST", headers: signEngineRequest(credentialBody.credential, "POST", "/api/engine/heartbeat", heartbeatBody), body: heartbeatBody });
  assert.equal(heartbeat.status, 200);
  await engine.stop();
  assert.equal(engine.snapshot().status, "stopped");
  assert.equal("transactionSignature" in engine.snapshot(), false);
  console.log("REAL-1 paper smoke passed: identity, pairing, RPC read, heartbeat, STOP, no transaction signature");
}
