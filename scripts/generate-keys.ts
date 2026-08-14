/**
 * Run ONCE to generate the ARIA license signing keypair.
 *
 *   npm run keygen
 *
 * Outputs two base64url values:
 *   ARIA_LICENSE_PRIVATE_D  → backend secret. Railway env var. NEVER commit, NEVER share.
 *   ARIA_LICENSE_PUBLIC_X   → safe to be public. Goes in the backend env AND gets
 *                             baked into the sniper client source so it can verify
 *                             licenses fully offline.
 *
 * If you ever suspect ARIA_LICENSE_PRIVATE_D leaked, run this again, redeploy the
 * backend with the new value, and ship a new sniper client build with the new
 * ARIA_LICENSE_PUBLIC_X. Every license issued under the old key stops verifying
 * the moment a user updates — that's your kill switch.
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };

console.log("\n─────────────────────────────────────────────────────────────");
console.log(" ARIA LICENSE SIGNING KEYPAIR — generated", new Date().toISOString());
console.log("─────────────────────────────────────────────────────────────\n");
console.log("Paste into Railway → Variables (backend only, keep secret):\n");
console.log(`ARIA_LICENSE_PRIVATE_D=${privJwk.d}`);
console.log(`ARIA_LICENSE_PUBLIC_X=${pubJwk.x}\n`);
console.log("Also paste ARIA_LICENSE_PUBLIC_X into the sniper client's");
console.log("src/license.ts as ARIA_PUBLIC_KEY_X (safe to be public, verification only).\n");
console.log("─────────────────────────────────────────────────────────────\n");
