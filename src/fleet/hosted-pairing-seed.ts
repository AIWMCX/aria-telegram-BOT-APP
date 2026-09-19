import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { issueReal1BetaEntitlementToken } from "../engine-entitlement-signer.js";
import { ENTITLEMENT_ISSUANCE_ENABLED } from "../config.js";

/**
 * Hosted PAPER Engine — P0 fix (2026-09-19): the hosted `/paper_start` flow
 * (hosted-commands.ts's `startHostedEngine`, wired to bot.ts's
 * `registerHostedClient`/`convertClientToHosted`) already seeds a real
 * Ed25519 device identity into a tenant's runtime directory
 * (hosted-device-identity.ts) so the spawned `aria-engine` CLI's own
 * `loadOrCreateDeviceIdentity()` finds a matching keypair instead of
 * generating an orphaned one. But `aria-engine`'s `cmdPaperStart` (cli.ts)
 * ALSO hard-requires, before it will do anything else:
 *
 *   1. `loadPairingState()` (pairing-state.ts) finding a real
 *      `state/pairing-state.json` in the runtime dir — normally written by
 *      the LOCAL `aria pair <CODE>` CLI flow (pairing-client.ts's
 *      `pairDevice`) after a real handshake against `/api/engine/pair`.
 *   2. `checkPaperStartEntitlement()` (entitlement-gate.ts) verifying an
 *      Ed25519-signed ARIAE1 token — read from that SAME pairing-state.json
 *      file's `entitlementToken` field — against the public key baked into
 *      the engine binary.
 *
 * A hosted tenant's runtime directory never got either of these written to
 * it: `registerHostedClient`/`convertClientToHosted` seed device identity
 * only. So even with device identity correctly seeded and the Fleet Manager
 * correctly spawning the real engine binary, a real hosted `/paper_start`
 * from Telegram would fail immediately with "Device is not paired."
 *
 * This module closes that gap by REUSING, not duplicating, the exact same
 * mechanisms the local `aria pair <CODE>` flow already uses end-to-end:
 *
 *   - The on-disk shape written here is byte-for-byte the same shape
 *     `pairDevice` (aria-engine's pairing-client.ts) writes via
 *     `savePairingState` — see aria-engine's `pairing-state.ts`:
 *     `{ clientId, lastSequence, entitlementToken? }`. `lastSequence`
 *     starts at 0 for a freshly paired/hosted device, exactly like a real
 *     `aria pair <CODE>` handshake — see `pairDevice`'s own
 *     `savePairingState({ clientId, lastSequence: 0, entitlementToken })`.
 *   - The entitlement token is minted with THIS repo's own
 *     `issueReal1BetaEntitlementToken` (engine-entitlement-signer.ts) —
 *     imported and called directly, never reimplemented — the exact same
 *     function `/api/engine/pair` (server.ts) calls for a locally-paired
 *     device. The signing key (`ARIA_ENTITLEMENT_PRIVATE_D`) never leaves
 *     that one file either way.
 *   - The file is written to `<runtimeDir>/state/pairing-state.json` —
 *     the exact path aria-engine's `pairing-state.ts` reads via
 *     `DEFAULT_KEYSTORE_DIR` (`runtime/paths.ts`'s `STATE_DIR`, which
 *     itself resolves under `ARIA_RUNTIME_DIR` when set — the same env var
 *     the Fleet Manager already sets on the spawned child process, and the
 *     same `state/` directory `writeHostedDeviceIdentityToDisk` already
 *     writes `device-identity.json` into).
 *
 * NOT addressed here, disclosed rather than silently left out: the real
 * `/api/engine/pair` flow ALSO creates a server-side `engine_entitlements`
 * DB row (`getOrCreateTrialEntitlement`, engine-entitlements.ts) that the
 * `/api/engine/sync` endpoint later reads to populate `entitlementStatus`
 * on every sync response — this is the channel `lastKnownEntitlementStatus`
 * (pairing-state.ts) and REAL-1 blocker #3's revocation-before-natural-
 * expiry enforcement depend on. A hosted tenant seeded ONLY by this module
 * has a valid, offline-verifiable 7-day token (so `checkPaperStartEntitlement`
 * genuinely grants access — the P0 this fixes) but no `engine_entitlements`
 * row, so a server-side revocation issued before that token's natural
 * expiry would not yet propagate to it via sync. This is a real, narrower
 * gap than the P0 fixed here, not silently absorbed into this fix's scope —
 * left as a disclosed follow-up (see the ledger entry for this fix).
 */

const PAIRING_STATE_FILE = "pairing-state.json";

export interface HostedPairingState {
  clientId: string;
  lastSequence: number;
  entitlementToken?: string;
}

/**
 * Pure — mints (or, if entitlement issuance isn't configured in this
 * environment, omits) a real signed ARIAE1 token and returns the pairing
 * state object to write. No filesystem access, matching
 * `generateHostedDeviceIdentity`'s own pure/impure split in
 * hosted-device-identity.ts.
 *
 * Mirrors server.ts's `/api/engine/pair` handler exactly: entitlement
 * issuance is best-effort and never blocks pairing/hosting itself — a
 * paired-but-unentitled state is a real, valid state there (e.g. issuance
 * briefly misconfigured), and the same is true here. If issuance is
 * disabled or throws, `entitlementToken` is simply omitted; the caller
 * still gets a valid pairing-state.json (satisfying gate #1,
 * `loadPairingState()`), just one that will fail gate #2
 * (`checkPaperStartEntitlement`) with reason "malformed"/"missing" —
 * exactly the same fail-closed outcome a locally-paired device with
 * issuance disabled would get.
 */
export function buildHostedPairingState(clientId: string): HostedPairingState {
  const state: HostedPairingState = { clientId, lastSequence: 0 };
  if (!ENTITLEMENT_ISSUANCE_ENABLED) return state;
  try {
    state.entitlementToken = issueReal1BetaEntitlementToken(clientId, randomUUID()).token;
  } catch {
    // Never fail hosted provisioning over entitlement issuance — same
    // fail-open-on-issuance/fail-closed-on-verification contract server.ts
    // already established for the local pairing flow.
  }
  return state;
}

/**
 * Writes a previously-built pairing state into
 * `<runtimeDir>/state/pairing-state.json`, matching aria-engine's
 * `pairing-state.ts`'s `savePairingState` exactly (same relative path,
 * same JSON shape, same 0o600/0o700 permissions). Idempotent overwrite —
 * safe to call again on retry, exactly like `writeHostedDeviceIdentityToDisk`.
 */
export function writeHostedPairingStateToDisk(runtimeDir: string, state: HostedPairingState): void {
  const stateDir = path.join(runtimeDir, "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, PAIRING_STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * The one function callers (bot.ts's `registerHostedClient`/
 * `convertClientToHosted`) actually need: builds and writes the pairing
 * state in one call, returning what was written so a caller can log/assert
 * on it if needed. Must be called — like `writeHostedDeviceIdentityToDisk`
 * — BEFORE the DB commit that depends on it (`setHostingMode`/
 * `rotateClientDeviceIdentityAndSetHosted`), preserving the same
 * write-before-commit crash-safety discipline Task 4's review fixes
 * already established for device identity: if this throws (disk full,
 * permissions, or an unexpected error inside token issuance not already
 * caught by `buildHostedPairingState`), the caller must throw before
 * touching the DB, so a crash here leaves the row's hosting_mode
 * unchanged and a retry redoes this step from scratch — self-healing,
 * never a half-provisioned "hosted" row with no pairing state backing it.
 */
export function seedHostedPairingState(runtimeDir: string, clientId: string): HostedPairingState {
  const state = buildHostedPairingState(clientId);
  writeHostedPairingStateToDisk(runtimeDir, state);
  return state;
}
