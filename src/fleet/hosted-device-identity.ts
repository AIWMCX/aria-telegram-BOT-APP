import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";

/**
 * Hosted PAPER Engine, Task 4 — device-identity provisioning for a
 * hosted-only tenant (a user who never ran `aria pair <code>` locally and
 * whose FIRST engine_clients row is created by the `/paper_start` command
 * itself, not by the existing pairing handshake in engine-pairing.ts).
 *
 * Design decision (documented per the task's explicit instruction to
 * decide and record the reasoning, not just implement something):
 *
 * `engine_clients.device_public_key` is NOT NULL UNIQUE (see
 * migrations/1755500100000_create-engine-clients.js), and the sync
 * protocol (server.ts's /api/engine/sync) identifies a client purely by
 * this key plus an Ed25519 signature the running engine process computes
 * with the MATCHING private key (device-auth.ts's verifyDeviceSignature).
 * A synthetic non-cryptographic placeholder string (e.g. `"hosted:" + a
 * random uuid`) would satisfy the NOT NULL/UNIQUE constraint at INSERT
 * time, but would permanently break the actual hosted engine process: it
 * has no matching private key, so the very first real
 * `/api/engine/sync` call the spawned aria-engine CLI makes would fail
 * signature verification and the hosted tenant could never sync its PAPER
 * state to the control plane — the entire point of hosting it.
 *
 * So this module generates a REAL, functioning Ed25519 keypair
 * server-side, using the exact same node:crypto APIs and on-disk file
 * format aria-engine's own `src/local-keystore.ts` uses
 * (`device-identity.json` under `<ARIA_RUNTIME_DIR>/state`, holding
 * `publicKeyX` — the JWK "x" value — and `privateKeyPkcs8Base64`) — and
 * writes it into the tenant's runtime directory BEFORE the Fleet Manager
 * spawns the process. When the real `aria-engine` CLI boots for that
 * tenant, its own `loadOrCreateDeviceIdentity()` (local-keystore.ts) finds
 * this pre-seeded file and loads it rather than generating a fresh,
 * mismatched one — so the identity registered in `engine_clients` at
 * creation time is BYTE-IDENTICAL to the one the running process actually
 * signs sync requests with, with no separate pairing-code handshake
 * required. This is the reason a real keypair was chosen over a
 * recognizably-fake marker string: a marker string is distinguishable by
 * construction, but non-functional; a real keypair is functional, and its
 * collision-freedom with every other real device key (paired or hosted)
 * comes from the same source both rely on — a 32-byte Ed25519 public key
 * drawn from a ~2^256 keyspace, the same guarantee any two independently
 * paired local devices already rely on to never collide with each other.
 * The database's own UNIQUE constraint on `device_public_key` remains the
 * hard backstop regardless (an INSERT would fail loudly, never silently
 * collide, in the astronomically unlikely event of a clash).
 *
 * Coupling risk, disclosed: this format must stay in sync with
 * aria-engine's `local-keystore.ts`. If that file's on-disk shape ever
 * changes, this module (a different repo) needs a matching update — there
 * is no shared package between the two repos to enforce this at
 * compile-time. Documented here so a future change to local-keystore.ts
 * is a known, not a silently-discovered, cross-repo break.
 */

export interface HostedDeviceIdentity {
  publicKeyX: string;
  privateKeyPkcs8Base64: string;
}

const IDENTITY_FILE = "device-identity.json";

/** Pure key generation — no filesystem access, safe to call before a tenant's runtime directory even exists (or in a unit test with no disk at all). */
export function generateHostedDeviceIdentity(): HostedDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privPkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { publicKeyX: pubJwk.x, privateKeyPkcs8Base64: privPkcs8.toString("base64") };
}

/**
 * Writes a previously-generated identity into `<runtimeDir>/state/device-identity.json`,
 * matching aria-engine's local-keystore.ts exactly (same relative path, same
 * JSON shape, same 0o600/0o700 permissions). Idempotent overwrite — callers
 * only invoke this once, at hosted-client creation time, before the tenant
 * has ever been spawned, so there is no existing file to clobber in
 * practice; still safe if called again with the same identity.
 */
export function writeHostedDeviceIdentityToDisk(runtimeDir: string, identity: HostedDeviceIdentity): void {
  const stateDir = path.join(runtimeDir, "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, IDENTITY_FILE), JSON.stringify(identity, null, 2), { mode: 0o600 });
}
