import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { loadEngineConfig, redactEngineConfig } from "./config.js";
import { validateLicense } from "./license.js";

const env = {
  ARIA_ENGINE_API_URL: "https://aria.example.com",
  ARIA_ENGINE_RPC_URL: "https://api.devnet.solana.com",
  ARIA_ENGINE_WALLET_REF: "os-keystore://aria/default",
  ARIA_ENGINE_LICENSE: "ARIA1.payload.signature",
  ARIA_ENGINE_NETWORK: "solana-devnet",
  ARIA_ENGINE_MODE: "paper",
  ARIA_ENGINE_VERSION: "0.1.0",
};
const config = loadEngineConfig(env);
const redacted = redactEngineConfig(config);
assert.equal(redacted.walletReference, "[LOCAL_ONLY]");
assert.equal(redacted.license, "[REDACTED]");
assert.equal(JSON.stringify(redacted).includes("api.devnet.solana.com"), true);
assert.equal(JSON.stringify(redacted).includes("ARIA1.payload.signature"), false);
assert.throws(() => loadEngineConfig({ ...env, ARIA_ENGINE_MODE: "live" }));
assert.throws(() => loadEngineConfig({ ...env, ARIA_ENGINE_RPC_URL: "http://localhost:8899" }));
assert.throws(() => loadEngineConfig({ ...env, PRIVATE_KEY: "must-never-be-accepted" }));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicJwk = publicKey.export({ format: "jwk" }) as { x: string };
const privateJwk = privateKey.export({ format: "jwk" }) as { d: string };
const payload = {
  v: 1, iss: "aria", sub: "lead_1", email: "user@example.com", tg_user_id: 1,
  wallet: "So11111111111111111111111111111111111111112", tier: "trial", features: ["paper"],
  limits: { maxBuySol: 0.02, maxPositions: 5, maxTotalSol: 0.1 },
  iat: 1_700_000_000, exp: 1_900_000_000, jti: "lic_test",
};
const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signaturePart = sign(null, Buffer.from(payloadPart), { key: privateKey }).toString("base64url");
const token = `ARIA1.${payloadPart}.${signaturePart}`;
assert.equal(validateLicense(token, publicJwk.x, new Date("2028-01-01T00:00:00Z")).status, "valid");
assert.equal(validateLicense(token, publicJwk.x, new Date("2031-01-01T00:00:00Z")).status, "expired");
assert.equal(validateLicense(`${token}x`, publicJwk.x, new Date()).status, "invalid");
assert.equal(validateLicense(token, publicJwk.x.slice(1), new Date()).status, "invalid");
void privateJwk;

console.log("engine config and licence tests passed");
