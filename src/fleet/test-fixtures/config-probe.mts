// Test-only: loads the real config.ts with a minimal valid env and prints the
// parsed FLEET values (or dies like production would on a bad FLEET_* value).
import { generateKeyPairSync } from "node:crypto";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.TELEGRAM_BOT_TOKEN ??= "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL ??= "http://localhost:8080";
process.env.RESEND_API_KEY ??= "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL ??= "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = (privateKey.export({ format: "jwk" }) as { d: string }).d;
process.env.ARIA_LICENSE_PUBLIC_X = (publicKey.export({ format: "jwk" }) as { x: string }).x;
process.env.LOG_LEVEL = "error";
const { CONFIG, FLEET_FLAGS } = await import("../../config.js");
console.log(`MAX=${CONFIG.FLEET_MAX_CONCURRENT_TENANTS} ENABLED=${FLEET_FLAGS.enabled}`);
