# REAL-1 Commercial Sniper Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a commercially usable paper-mode ARIA product composed of a local customer engine and Telegram control center, driven by real Solana/RPC/quote data and containing no transaction-signing capability.

**Architecture:** `AIWMCX/aria-telegram-BOT-APP` remains the public Railway control plane and Telegram Mini App. A separate private `AIWMCX/aria-engine` repository contains the customer-local Node.js CLI/daemon. Pairing uses one-time codes; the engine generates a local Ed25519 device identity and authenticates every sync by signature, timestamp, and monotonic sequence. The engine reads real Solana state and market quotes, evaluates risk, and creates paper positions only; REAL-1 ships no wallet-private-key loader, transaction builder, signer, or broadcaster.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.7+, PostgreSQL, Hono, grammy, Node native `crypto`, `@solana/web3.js` or the repo-selected official Solana JS client at implementation time, WebSocket JSON-RPC, Jupiter quote API via a thin adapter, plain browser JavaScript for the existing Mini App, GitHub Actions, Railway for the control plane.

## Global Constraints

- FREE-1A must be merged and exact-SHA production-verified before REAL-1 implementation branches are cut.
- REAL-1 is paper execution only. `liveExecution` is literally `false` in the public entitlement type.
- The engine must not contain or accept `PRIVATE_KEY`, `SEED_PHRASE`, `KEYPAIR_PATH`, `WALLET_SECRET`, transaction signing, transaction construction, or transaction broadcasting.
- Customer RPC credentials remain local; logs and sync payloads redact secret-bearing URLs.
- No generated/random demo opportunity, position, PnL, or event is allowed on the authenticated commercial path.
- The customer-facing trial is exactly 7 × 24 hours from REAL-1 entitlement creation.
- Existing legacy license tokens are preserved for backward compatibility and are not silently shortened.
- Browser state is presentation only; control plane and engine re-enforce every authorization/risk rule.
- Local STOP works without the control plane and cannot be overridden remotely while locally latched.
- Engine starts `stopped` after every process restart.
- Control-plane engine state is `CONNECTED` only when a verified sync is <=6 seconds old; `STALE` at >6s and <=30s; `DISCONNECTED` after 30s.
- Exact-SHA CI is required in both repositories before beta packaging.
- Secret-pattern scanning is required for both repositories before release.
- Implementation must use red-green-refactor for every behavior-bearing task.
- Do not repurpose `AIWMCX/ARIA-Solana-Sniper` or `AIWMCX/main_sniper` as the canonical engine repository. Provision a dedicated private `AIWMCX/aria-engine` repository.

---

## Repository precondition

The connected GitHub tool in this session cannot create repositories. Before Task 2 is executed, provision **private** repository `AIWMCX/aria-engine` with default branch `main`, then connect/authorize it to the same GitHub integration. Do not place proprietary engine source into the public control-plane repo as a workaround.

REAL-1 implementation begins only after FREE-1A release closure. The control-plane implementation branch must be created from the exact FREE-1A merge SHA, and `aria-engine` begins from its own empty `main`.

---

## File Structure

### Control plane — `AIWMCX/aria-telegram-BOT-APP`

**Create**

- `migrations/003_engine_control_plane.sql` — additive REAL-1 tables/indexes.
- `src/engine/types.ts` — exact protocol/domain types shared by engine-facing endpoints.
- `src/engine/entitlements.ts` — create/read/expire/revoke 7-day REAL-1 entitlements.
- `src/engine/pairing.ts` — one-time pairing-code creation/consumption.
- `src/engine/clients.ts` — paired-device registry and sequence/replay state.
- `src/engine/signature.ts` — canonical request construction and Ed25519 verification.
- `src/engine/snapshots.ts` — exact-shape validation, sanitization, latest snapshot persistence.
- `src/engine/events.ts` — idempotent bounded event ingestion.
- `src/engine/commands.ts` — START_PAPER/STOP/UPDATE_SETTINGS/RESYNC queue.
- `src/engine/routes.ts` — Hono route registration for engine/customer APIs.
- `test/engine-control-plane.ts` — protocol/auth/ownership/replay/entitlement tests.
- `test/engine-frontend.ts` — shipped Mini App application-shell runtime tests.

**Modify**

- `src/server.ts` — register REAL-1 routes.
- `src/config.ts` — REAL-1 feature flag and global product capability transition only after real integration is complete.
- `src/product-reality.ts` — capability values can support `liveData` and `paperExecution` only after Tasks 1-8 pass.
- `src/index.ts` — optional entitlement expiry maintenance job.
- `public/index.html` — replace authenticated demo/license home with application shell.
- `public/app.js` — account/engine/snapshot/command/settings application logic; remove simulator from authenticated path.
- `public/styles.css` — application navigation/status/positions/activity/settings UI.
- `package.json` — new focused tests, aggregate CI scripts.
- `README.md` — beta install/pair/run instructions.
- `.env.example` — REAL-1 feature flag and non-secret engine-control settings only.

### Engine — private `AIWMCX/aria-engine`

**Create**

- `package.json` — private package metadata/scripts/bin.
- `tsconfig.json` — strict NodeNext TypeScript.
- `.gitignore` — local config/state/coverage/package outputs.
- `.github/workflows/ci.yml` — install/typecheck/test/package gate.
- `src/cli.ts` — command dispatch.
- `src/config.ts` — exact local config schema and redacted display.
- `src/paths.ts` — OS-specific config/state paths.
- `src/device-identity.ts` — Ed25519 device keypair generation/storage/signing.
- `src/control-plane.ts` — pair/sync HTTP client.
- `src/protocol.ts` — exact REAL-1 wire types/canonical signature input.
- `src/entitlement.ts` — local entitlement state/120-second grace behavior.
- `src/stop.ts` — local stop latch.
- `src/runtime.ts` — engine state machine.
- `src/rpc.ts` — HTTP RPC health/network/slot/public-wallet balance.
- `src/ws.ts` — reconnecting WebSocket RPC client.
- `src/opportunity-source.ts` — source interface and program-log implementation.
- `src/opportunity.ts` — dedupe/lifecycle/rejection reasons.
- `src/quote-provider.ts` — provider interface.
- `src/jupiter-quote.ts` — Jupiter quote adapter.
- `src/risk.ts` — deterministic paper-entry gates.
- `src/paper.ts` — bankroll/positions/entry/exit/PnL.
- `src/state-store.ts` — atomic local paper state/event buffer.
- `src/events.ts` — structured sanitized operational events.
- `src/doctor.ts` — installation/dependency diagnostics.
- `src/redact.ts` — URL/log/payload redaction.
- `test/*.test.ts` — unit/integration suites described below.
- `README.md` — customer beta installation/commands/security contract.

---

### Task 1: Close FREE-1A and establish exact REAL-1 base

**Files:**
- No code changes.
- Evidence: PR #3, production URLs, GitHub Actions, Railway deployment metadata.

**Interfaces:**
- Consumes: FREE-1A head `81035884582987293eb4e142beb26cf940d88c51` and its successful CI run.
- Produces: exact FREE-1A merge SHA and verified production baseline from which REAL-1 branches are cut.

- [ ] **Step 1: Verify PR #3 still points at the independently reviewed head**

Expected head:

```text
81035884582987293eb4e142beb26cf940d88c51
```

If it moved, re-run independent review and exact-SHA CI before merge.

- [ ] **Step 2: Approve and merge only the reviewed SHA**

Use GitHub expected-head protection when merging. Record resulting merge SHA as `FREE1A_MERGE_SHA`.

- [ ] **Step 3: Verify exact Railway deploy SHA**

Expected: Railway deployment metadata identifies `FREE1A_MERGE_SHA`, not merely “latest deployment succeeded.”

- [ ] **Step 4: Verify production health and reality contract**

Expected `/healthz` => HTTP 200 and `{ "ok": true, ... }`.

Expected `/api/product-reality` reality fields:

```json
{
  "environment": "production",
  "network": "offline",
  "dataMode": "simulated",
  "executionMode": "disabled",
  "controlState": "stopped"
}
```

`paymentsEnabled` may reflect actual Stripe configuration.

- [ ] **Step 5: Verify Telegram production truth UI**

No hard-coded LIVE flash; simulation disclosures visible; failure path produces unavailable state; no generated activity begins after failed reality retrieval.

- [ ] **Step 6: Cut REAL-1 control-plane branch from exact merge SHA**

```bash
git switch --detach "$FREE1A_MERGE_SHA"
git switch -c codex/real-1-control-plane
```

Expected: branch base exactly equals `FREE1A_MERGE_SHA`.

---

### Task 2: Provision the private engine repository and lock the no-signer contract

**Files (engine):**
- Create all package/config/CI scaffolding listed under Engine File Structure.
- Test: `test/no-signer-contract.test.ts`

**Interfaces:**
- Produces: a buildable private `aria-engine` package, CLI bin `aria-engine`, strict configuration schema, and a CI-enforced prohibition on wallet-signing configuration.

- [ ] **Step 1: Provision private repo**

Create `AIWMCX/aria-engine` as **private**, default branch `main`. Add the existing GitHub integration.

Expected: repository visibility is private and code search/connector access works.

- [ ] **Step 2: Add failing no-signer configuration tests**

Create `test/no-signer-contract.test.ts`:

```ts
import assert from "node:assert/strict";
import { parseEngineConfig } from "../src/config.js";

for (const forbidden of [
  "PRIVATE_KEY",
  "SEED_PHRASE",
  "KEYPAIR_PATH",
  "WALLET_SECRET",
]) {
  assert.throws(
    () => parseEngineConfig({ [forbidden]: "secret-value" } as Record<string, string>),
    /unsupported|forbidden|unknown/i,
  );
}

console.log("no-signer configuration contract passed");
```

- [ ] **Step 3: Run and observe RED**

```bash
npm test
```

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 4: Add package/TypeScript/CLI skeleton and exact config schema**

`src/config.ts` must expose:

```ts
export interface EngineConfigV1 {
  controlPlaneUrl: string;
  network: "solana-mainnet" | "solana-devnet";
  rpcHttpUrl: string;
  rpcWsUrl: string;
  publicWallet: string | null;
  paper: PaperSettings;
}

export function parseEngineConfig(input: unknown): EngineConfigV1;
```

Use exact-key validation. Unknown keys fail. No signer/private-key key exists.

- [ ] **Step 5: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm pack --dry-run
```

- [ ] **Step 6: Verify GREEN**

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

Expected: PASS; tarball file list contains no local config/state/secret files.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: bootstrap private REAL-1 engine"
```

---

### Task 3: Add REAL-1 entitlement, pairing, client identity, and signed sync to the control plane

**Files (control plane):**
- Create: `migrations/003_engine_control_plane.sql`
- Create: `src/engine/types.ts`
- Create: `src/engine/entitlements.ts`
- Create: `src/engine/pairing.ts`
- Create: `src/engine/clients.ts`
- Create: `src/engine/signature.ts`
- Create: `src/engine/snapshots.ts`
- Create: `src/engine/events.ts`
- Create: `src/engine/commands.ts`
- Create: `src/engine/routes.ts`
- Create: `test/engine-control-plane.ts`
- Modify: `src/server.ts`
- Modify: `package.json`

**Interfaces:**
- Produces authenticated routes:
  - `GET /api/engine/account`
  - `POST /api/engine/pairing-code`
  - `POST /api/engine/pair`
  - `POST /api/engine/sync`
  - `POST /api/engine/commands`
  - `POST /api/engine/clients/:id/revoke`

- [ ] **Step 1: Write RED tests for 7-day entitlement and cross-user isolation**

Add assertions that a newly created REAL-1 entitlement has:

```ts
status === "trial"
paperExecution === true
liveExecution === false
expiresAt - startsAt === 7 * 24 * 60 * 60 * 1000
```

Assert Telegram user A cannot view/pair/control user B's client.

- [ ] **Step 2: Write RED tests for pairing-code security**

Assert:

- code creation requires verified Telegram initData;
- inactive/expired entitlement => rejected;
- code expires after 10 minutes;
- code is single-use;
- creating another code invalidates earlier unconsumed code;
- DB stores a code hash, never plaintext code.

- [ ] **Step 3: Write RED tests for signed sync/replay**

Test canonical input exactly:

```text
POST\n/api/engine/sync\n<clientId>\n<sequence>\n<timestamp>\n<sha256(body)>
```

Assert invalid signature, stale timestamp, same sequence, lower sequence, revoked client, wrong body hash all fail without updating `last_seen_at` or ingesting events.

- [ ] **Step 4: Run RED**

```bash
npm run test:engine
```

Expected: FAIL because REAL-1 tables/modules/routes do not exist.

- [ ] **Step 5: Create additive migration**

Create tables exactly from the REAL-1 design:

```text
engine_entitlements
engine_pairing_codes
engine_clients
engine_snapshots
engine_events
engine_commands
```

Use `BIGINT` for lamports/sequence; UUID primary keys; FK ownership; unique client event IDs; indexes on user/client/status/expiry/last_seen.

- [ ] **Step 6: Implement exact public types**

`src/engine/types.ts` must define:

```ts
export type EngineAccessStatus = "trial" | "active" | "expired" | "revoked";

export interface EngineEntitlement {
  product: "real-1";
  status: EngineAccessStatus;
  startsAt: string;
  expiresAt: string;
  paperExecution: boolean;
  liveExecution: false;
  maxPaperBuySol: number;
  maxPaperPositions: number;
}
```

and all V1 snapshot/sync/command types from the design with exact-key runtime validation.

- [ ] **Step 7: Implement entitlement source of truth**

New REAL-1 beta entitlement creation defaults:

```text
status=trial
expires_at=now + 7 days
max_paper_buy_lamports=20_000_000
max_paper_positions=5
```

Do not modify existing long-lived legacy `TIER_LIMITS.trial` license expiry in this task.

- [ ] **Step 8: Implement pairing-code issuance**

Generate at least 60 bits of entropy using Node native crypto. Display as `ABCD-EFGH-JKLM`; store SHA-256 hash only; consume atomically.

- [ ] **Step 9: Implement device binding and sync signature verification**

Use Node native `crypto.verify` with stored Ed25519 device public key. Timestamp tolerance: 60 seconds. Sequence must strictly increase and update atomically with accepted snapshot/events.

- [ ] **Step 10: Implement secret-field rejection**

Snapshot validator explicitly rejects keys matching:

```text
privateKey
seedPhrase
walletSecret
keypair
rpcUrl
rpcHttpUrl
rpcWsUrl
authorization
licenseToken
devicePrivateKey
```

Case-insensitive recursive scan before persistence.

- [ ] **Step 11: Implement commands with STOP priority**

Allowed kinds only:

```text
START_PAPER
STOP
UPDATE_SETTINGS
RESYNC
```

`STOP` sorts ahead of every queued non-STOP command for the same client. Commands expire; completed/rejected results are idempotent.

- [ ] **Step 12: Verify GREEN**

```bash
npm run test:engine
npm run test:backend
npm run typecheck
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add migrations src/engine src/server.ts test/engine-control-plane.ts package.json
git commit -m "feat: add REAL-1 engine control plane"
```

---

### Task 4: Implement engine device identity, pairing, signed sync, STOP, and diagnostics

**Files (engine):**
- Create/modify: `src/device-identity.ts`, `src/control-plane.ts`, `src/protocol.ts`, `src/entitlement.ts`, `src/stop.ts`, `src/runtime.ts`, `src/doctor.ts`, `src/events.ts`, `src/redact.ts`, `src/state-store.ts`, `src/cli.ts`
- Test: `test/device-auth.test.ts`, `test/stop.test.ts`, `test/entitlement.test.ts`, `test/redaction.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Consumes control-plane pairing/sync protocol from Task 3.
- Produces working CLI commands `pair`, `doctor`, `start`, `stop`, `status`, `unpair` and a signed sync loop.

- [ ] **Step 1: Write RED Ed25519 device identity tests**

Assert first pairing creates a keypair, subsequent starts reuse it, private key never appears in logs/config output, and config/state directory permissions are restricted where supported.

- [ ] **Step 2: Write RED STOP tests**

Assert local stop latch blocks start until explicitly cleared by local action; remote START cannot clear it; repeated STOP is idempotent; STOP works when HTTP client is forced offline.

- [ ] **Step 3: Write RED entitlement-grace tests**

Assert after last valid entitlement sync:

- <=120 seconds: existing paper runtime may continue;
- >120 seconds control plane unavailable: no new paper entries;
- expired/revoked entitlement: immediately no new paper entries;
- `status` and `stop` remain available.

- [ ] **Step 4: Write RED redaction tests**

Given:

```text
https://user:pass@example-rpc.test/?api-key=SECRET
wss://example-rpc.test/?token=SECRET
```

assert output contains host/scheme only and no credentials/query secret.

- [ ] **Step 5: Implement device key/storage/signature**

Use Node native crypto only. Export:

```ts
export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity>;
export function signSyncRequest(identity: DeviceIdentity, input: CanonicalSyncInput): string;
```

- [ ] **Step 6: Implement pair/sync client**

Pairing response persists `clientId`; sync calls serialize; sequence increments only once per outbound signed request and persisted sequence never moves backward after restart.

- [ ] **Step 7: Implement local STOP and runtime state machine**

States exactly:

```text
unpaired
stopped
starting
running_paper
stopping
degraded
license_blocked
```

Process boot always selects `stopped` for paired clients.

- [ ] **Step 8: Implement doctor base checks**

Output PASS/FAIL for version, identity, control-plane pairing, entitlement/expiry, clock skew; RPC/provider checks are added in Task 5.

- [ ] **Step 9: Verify GREEN**

```bash
npm run typecheck
npm test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "feat: add paired signed REAL-1 engine runtime"
```

---

### Task 5: Implement real Solana read-only runtime and truthful snapshot

**Files (engine):**
- Create/modify: `src/rpc.ts`, `src/ws.ts`, `src/runtime.ts`, `src/doctor.ts`, `src/protocol.ts`
- Test: `test/rpc.test.ts`, `test/ws.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Produces real network identity, latest slot/freshness, HTTP/WS health, public wallet SOL balance, and sanitized `EngineSnapshotV1`.

- [ ] **Step 1: Write RED RPC fixture tests**

Mock JSON-RPC responses for `getGenesisHash`/network identity, `getSlot`, `getBalance`. Assert lamports remain integer/string base units; wrong network produces an explicit configuration error.

- [ ] **Step 2: Write RED WebSocket reconnect tests**

Simulate disconnect and bounded exponential reconnect. Assert health transitions `connected -> degraded/offline -> connected` without synthesizing slots/events.

- [ ] **Step 3: Implement HTTP RPC adapter**

Expose:

```ts
export interface RpcStatus {
  network: "solana-mainnet" | "solana-devnet";
  lastSlot: number | null;
  health: "connected" | "degraded" | "offline";
}

export async function readWalletBalanceLamports(publicKey: string): Promise<bigint>;
```

- [ ] **Step 4: Implement WS client**

No inbound server. Customer machine initiates outbound WebSocket only. Bound reconnect delay and emit health events.

- [ ] **Step 5: Add RPC/WS/public-wallet checks to doctor**

Never print full RPC URLs. `doctor` fails on network mismatch or unreadable public wallet.

- [ ] **Step 6: Build sanitized snapshot**

All bigint amounts serialize as decimal strings. Snapshot contains public wallet address but no RPC URL.

- [ ] **Step 7: Verify with fixture tests**

```bash
npm test -- rpc ws snapshot doctor
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat: add real read-only Solana engine state"
```

---

### Task 6: Implement real opportunity observation and quote adapter

**Files (engine):**
- Create/modify: `src/opportunity-source.ts`, `src/opportunity.ts`, `src/quote-provider.ts`, `src/jupiter-quote.ts`, `src/events.ts`
- Test: `test/opportunity.test.ts`, `test/quote-provider.test.ts`

**Interfaces:**
- Produces deduplicated `RawOpportunity` from real Solana program-log observations and `QuoteResult` from current Jupiter quote API.

- [ ] **Step 1: Verify current official Solana and Jupiter API contracts**

Use only current official docs. Record URLs/behavior in code comments or implementation notes. Specifically verify WebSocket subscription semantics and current Jupiter quote endpoint/parameters; do not rely on remembered endpoints.

- [ ] **Step 2: Write RED opportunity fixture tests**

Feed deterministic log/transaction fixtures containing mint initialization and unrelated transactions. Assert only valid successful mint initialization becomes an opportunity; duplicates are suppressed by signature + instruction identity.

- [ ] **Step 3: Implement `OpportunitySource` interface**

```ts
export interface OpportunitySource {
  start(onOpportunity: (opportunity: RawOpportunity) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  health(): "connected" | "degraded" | "offline";
}
```

Program identifiers must come from the installed official Solana library/runtime constants where available rather than copied marketing constants.

- [ ] **Step 4: Write RED quote adapter tests**

Mock provider responses for route available, no route, malformed response, HTTP timeout, stale response. Assert no route/timeout does not open a paper position.

- [ ] **Step 5: Implement quote abstraction and Jupiter adapter**

Use integer base-unit amounts. Set a bounded HTTP timeout. Parse only exact required fields. Never treat HTTP 200 malformed JSON as a valid route.

- [ ] **Step 6: Implement bounded quoteability window**

New opportunity may retry quote lookup for a short bounded interval (implementation default 15 seconds, max within opportunity-age cap), then terminally reject `NO_ROUTE`/`QUOTE_UNAVAILABLE`.

- [ ] **Step 7: Verify GREEN**

```bash
npm test -- opportunity quote-provider
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat: observe real Solana opportunities and quotes"
```

---

### Task 7: Implement deterministic paper risk, bankroll, positions, PnL, and persistence

**Files (engine):**
- Create/modify: `src/risk.ts`, `src/paper.ts`, `src/state-store.ts`, `src/runtime.ts`, `src/events.ts`
- Test: `test/risk.test.ts`, `test/paper.test.ts`, `test/restart.test.ts`

**Interfaces:**
- Consumes real opportunities/quotes.
- Produces paper-only positions and events; never transaction signatures.

- [ ] **Step 1: Write RED risk ordering tests**

Risk gate order:

```text
STOP
entitlement
runtime mode
dependency health
opportunity age
quote freshness
mint authority policy
freeze authority policy
position cap
paper bankroll
```

First failed gate is the rejection reason. Unknown required data fails closed.

- [ ] **Step 2: Write RED bankroll/position math tests**

Use integer lamports/base units. Assert reservation/open/close never lets available paper bankroll become negative and totals reconcile exactly.

- [ ] **Step 3: Write RED stale-PnL tests**

If reverse quote exceeds `maxQuoteAgeMs` or provider unavailable, position PnL becomes `STALE/UNAVAILABLE`; last numeric PnL is not relabeled current.

- [ ] **Step 4: Write RED restart test**

Persist an open paper position, simulate process restart, assert position restores but runtime state is `stopped` and strategy does not auto-start.

- [ ] **Step 5: Implement risk gate**

Expose deterministic pure function where possible:

```ts
export function evaluatePaperEntry(input: PaperEntryContext): PaperEntryDecision;
```

- [ ] **Step 6: Implement paper position engine**

Entry records exact quote input/output/observedAt. Exit types:

```text
TP
SL
TRAILING
MANUAL
```

Manual close waits for next valid fresh reverse quote.

- [ ] **Step 7: Implement crash-safe local persistence**

Use atomic write/rename or SQLite; whichever is chosen must have an integration test proving an interrupted write does not replace valid prior state with truncated JSON. No financial-ledger claim is made.

- [ ] **Step 8: Verify GREEN**

```bash
npm test -- risk paper restart
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat: add deterministic REAL-1 paper engine"
```

---

### Task 8: Complete engine-to-control-plane commands and exactly-once event replay

**Files:**
- Engine: `src/control-plane.ts`, `src/runtime.ts`, `src/events.ts`, `src/state-store.ts`
- Control plane: `src/engine/commands.ts`, `src/engine/events.ts`, `test/engine-control-plane.ts`
- Tests (engine): `test/commands.test.ts`, `test/event-replay.test.ts`

**Interfaces:**
- End-to-end START_PAPER, STOP, UPDATE_SETTINGS, RESYNC with command-result acknowledgement and idempotent event replay.

- [ ] **Step 1: Write RED command tests**

Assert START_PAPER requires active entitlement, no local stop latch, healthy required dependencies, valid settings. STOP always accepted for owned client and applies idempotently.

- [ ] **Step 2: Write RED replay tests**

Simulate sync accepted but client missing response; retry events with same event IDs. Backend stores each event once; command result remains idempotent.

- [ ] **Step 3: Implement engine command dispatcher**

Unknown command kind => rejected, never ignored as success. Settings updates validate full settings object and entitlement caps before application.

- [ ] **Step 4: Implement bounded unsent event buffer**

Persist maximum 10,000 unsent events locally. If capacity is reached, preserve safety/state-transition events over low-value repetitive health events and emit a buffer-pressure warning; never leak secrets.

- [ ] **Step 5: Implement sync cadence**

Running: target 2 seconds. Stopped: target 10 seconds. Backoff on control-plane failure while entitlement grace rules remain enforced locally.

- [ ] **Step 6: Verify both repos**

Control plane:

```bash
npm run test:engine
npm run typecheck
```

Engine:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit both repos with bounded commits**

Control plane:

```bash
git commit -am "feat: complete REAL-1 command protocol"
```

Engine:

```bash
git commit -am "feat: sync REAL-1 commands and events"
```

---

### Task 9: Replace the authenticated Mini App demo with the REAL-1 control center

**Files (control plane):**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `test/engine-frontend.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes `/api/engine/account`, latest sanitized snapshot/events, and command endpoints.
- Produces six views: Overview, Sniper, Positions, Activity, Settings, Account/Install.

- [ ] **Step 1: Write RED shipped-JS application-shell tests**

Execute actual `public/app.js` in deterministic fake browser scenarios:

```text
active trial/no engine
connected stopped
running paper
real opportunity
paper position
stale snapshot
disconnected
malformed API
expired entitlement
STOP pending/applied
settings pending/applied/rejected
```

Assert no random timer creates opportunities/positions/events.

- [ ] **Step 2: Replace authenticated home**

After Telegram user has REAL-1 access, default route is Overview, not pricing/license marketing. Unauthenticated/no-access users may still see access/onboarding flow.

- [ ] **Step 3: Build exact navigation and truth status**

Views:

```text
Overview
Sniper
Positions
Activity
Settings
Account
```

Status derivation:

```text
<=6s CONNECTED
>6s <=30s STALE
>30s DISCONNECTED
invalid/fetch failure UNAVAILABLE
```

- [ ] **Step 4: Implement Overview**

Render entitlement/expiry, client/version/runtime/network/dependency health, public wallet + real SOL balance, paper bankroll, START PAPER/STOP.

- [ ] **Step 5: Implement Sniper/Positions/Activity**

Only backend-relayed engine data. Every position has persistent `PAPER` label. Stale price never appears as current.

- [ ] **Step 6: Implement Settings command workflow**

Settings submit => pending. UI changes to applied only after engine command result. Rejected settings show exact safe reason.

- [ ] **Step 7: Implement Account/Install**

Show exact trial dates, generate pairing code, paired device, revoke device, version, installation command sequence, diagnostics checklist/support.

- [ ] **Step 8: Remove simulator from authenticated commercial path**

No `scheduleDetect`, random symbols, random PnL, generated buys/sells, or equivalent timer can execute for authenticated REAL-1 users. Static source regression test scans prohibited legacy patterns.

- [ ] **Step 9: Verify GREEN**

```bash
npm run test:frontend
npm run test:engine
npm run test:backend
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add public test package.json
git commit -m "feat: replace demo with REAL-1 control center"
```

---

### Task 10: Promote global product reality only after real integrations are proven

**Files (control plane):**
- Modify: `src/product-reality.ts`
- Modify: `.env.example`
- Modify: tests for product reality/frontend.

**Interfaces:**
- Changes global capability gates from no live-data/paper support to code-backed REAL-1 support.

- [ ] **Step 1: Write RED capability test**

Expected new capability constant after REAL-1 implementation:

```ts
{
  liveData: true,
  paperExecution: true,
  devnetExecution: false,
  mainnetExecution: false,
}
```

- [ ] **Step 2: Keep semantic distinction explicit**

Allowed global production reality:

```text
network=solana-mainnet
dataMode=live
executionMode=paper
```

This means real mainnet **data**, paper **execution**. It must not produce the text `MAINNET EXECUTION` anywhere.

- [ ] **Step 3: Implement capability change and tests**

Only after Tasks 3-9 have green exact-SHA CI candidates. If engine integration is incomplete, do not make this change.

- [ ] **Step 4: Verify**

```bash
npm run test:reality
npm run test:frontend
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/product-reality.ts .env.example test
git commit -m "feat: expose REAL-1 live-data paper capability"
```

---

### Task 11: Installation packaging, version contract, and customer diagnostics

**Files (engine):**
- Modify: `package.json`, `README.md`, `src/cli.ts`, `src/doctor.ts`
- Create: `scripts/check-package.mjs`
- Test: `test/package-contract.test.ts`

**Files (control plane):**
- Modify: `README.md`, `public/index.html`, `public/app.js`

**Interfaces:**
- Produces a versioned beta package and exact customer installation/pairing flow.

- [ ] **Step 1: Define version compatibility**

Control plane returns minimum/supported engine protocol version. Engine sends package and protocol version in snapshot. Unsupported version may still STOP/status/unpair but cannot START.

- [ ] **Step 2: Add package-content test**

`npm pack --json` must not include `.env`, config, state DB, test fixtures containing secrets, local logs, coverage, device keys.

- [ ] **Step 3: Complete `doctor`**

PASS/FAIL:

```text
engine version
config permissions
device identity
control plane pairing
entitlement and exact expiry
clock skew
HTTP RPC
WebSocket RPC
network identity
public wallet balance lookup
quote provider
```

- [ ] **Step 4: Document install flow exactly**

```text
Install Node >=22.13
Install exact ARIA beta package artifact
aria-engine version
Generate pairing code in Telegram
aria-engine pair <CODE>
aria-engine config set rpcHttpUrl <URL>
aria-engine config set rpcWsUrl <URL>
aria-engine config set publicWallet <PUBLIC_ADDRESS>
aria-engine doctor
aria-engine start
```

Do not tell customer to enter a private key in REAL-1.

- [ ] **Step 5: Verify package**

```bash
npm ci
npm run typecheck
npm test
npm pack --json
node scripts/check-package.mjs
sha256sum *.tgz
```

Record package filename, version, commit SHA, SHA256.

- [ ] **Step 6: Commit docs/package contract**

Engine and control-plane commits should each be bounded to documentation/package changes.

---

### Task 12: Independent security/scope review and exact-SHA CI gates

**Files:**
- No behavior changes unless review finds defects.

**Interfaces:**
- Produces review evidence and merge candidates in both repos.

- [ ] **Step 1: Run full gates in engine**

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

- [ ] **Step 2: Run full gates in control plane**

```bash
npm ci
npm run typecheck
npm test
```

- [ ] **Step 3: Run secret/signer scope scan**

Review changed code for actual secrets and for forbidden functionality. Engine code must not implement/import a signer, wallet private-key loader, sendTransaction, signTransaction, transaction broadcaster, Jito bundle sender, or secret-key environment parser.

- [ ] **Step 4: Independent reviewer questions**

Reviewer must answer:

```text
Can browser/client A access client B?
Can a replayed signed sync mutate state twice?
Can stale/disconnected state appear CONNECTED?
Can any random/demo generator create commercial activity?
Can expired trial start/open new paper positions?
Can remote START override local STOP?
Can malformed/unknown data become a successful paper fill?
Can stale quote appear as current PnL?
Can any wallet private key enter REAL-1 config or logs?
Can engine package accidentally ship local keys/config/state?
Can global reality call paper execution mainnet execution?
```

Any P0/P1 blocks merge.

- [ ] **Step 5: Verify exact GitHub Actions SHA in both repos**

Record:

```text
CONTROL_PLANE_SHA
CONTROL_PLANE_CI_RUN
ENGINE_SHA
ENGINE_CI_RUN
ENGINE_PACKAGE_SHA256
```

Do not accept CI from an older head.

---

### Task 13: Deploy control plane and execute real paper-mode smoke test

**Files:**
- No code changes except defects discovered by smoke test.

**Interfaces:**
- Produces real runtime evidence for beta readiness.

- [ ] **Step 1: Merge only reviewed exact control-plane SHA**

Use expected-head SHA. Record merge SHA and rollback SHA.

- [ ] **Step 2: Verify exact Railway deployment**

Railway must identify that merge SHA. Run migrations. Verify `/healthz`.

- [ ] **Step 3: Configure REAL-1 product reality**

Only now set:

```text
ARIA_PRODUCT_ENVIRONMENT=production
ARIA_NETWORK_MODE=solana-mainnet
ARIA_DATA_MODE=live
ARIA_EXECUTION_MODE=paper
ARIA_CONTROL_STATE=stopped
```

Redeploy and verify `/api/product-reality` exactly.

- [ ] **Step 4: Pair one real beta engine**

From customer-like machine/environment:

```bash
aria-engine pair <one-time-code>
aria-engine config set rpcHttpUrl <real RPC HTTPS>
aria-engine config set rpcWsUrl <real RPC WSS>
aria-engine config set publicWallet <public wallet>
aria-engine doctor
```

No private key is entered.

- [ ] **Step 5: Verify read-only Solana evidence**

Compare engine-reported slot and wallet SOL balance with an independent RPC lookup. Record slot/timestamp/account and both values; values must agree within expected observation timing.

- [ ] **Step 6: Start paper mode**

Telegram START PAPER => command queued/delivered/applied => engine `running_paper` => Mini App reflects verified sync.

- [ ] **Step 7: Verify opportunity observation**

Observe a real Solana opportunity or run detector for a documented observation window. Zero opportunities during the window is acceptable; fabricated opportunity is not.

- [ ] **Step 8: Verify quote/paper path**

Use a current known-routable mint through the quote adapter integration path to prove a real quote can drive paper math without transaction signing. If organic opportunity qualifies, prefer that; otherwise perform a dedicated diagnostic quote smoke test clearly labeled diagnostic, not a sniper result.

- [ ] **Step 9: Verify STOP**

Telegram STOP => engine stops new entries. Then disconnect control-plane access and verify local `aria-engine stop` remains immediate/idempotent.

- [ ] **Step 10: Verify stale/disconnect truth**

Stop engine/network and observe Mini App transition CONNECTED -> STALE -> DISCONNECTED at specified boundaries with no generated events.

- [ ] **Step 11: Record runtime evidence**

Capture exact merge SHA, Railway deployment, product-reality response, paired engine SHA/version/package hash, doctor output with secrets redacted, Telegram states, STOP evidence, and any blockers.

---

### Task 14: REAL-1 commercial beta release declaration

**Files:**
- Update release notes / README only after runtime evidence passes.

**Interfaces:**
- Produces the customer-facing beta handoff and exact next-release boundary.

- [ ] **Step 1: Verify acceptance checklist from design**

All 18 acceptance criteria must be PASS or the session result is `PARTIAL`.

- [ ] **Step 2: Publish truthful beta wording**

Allowed:

```text
Real Solana data
Paper trading
Local ARIA engine
Telegram control center
7-day beta trial
No wallet private key required for REAL-1
```

Forbidden:

```text
Live trading
Mainnet execution
Autonomous real trades
Guaranteed returns
```

- [ ] **Step 3: Record next gate**

Next release is `LIVE-1 — Local signer and transaction execution design`. No signing/live code begins until that design is owner-approved and security-reviewed.

- [ ] **Step 4: Commit release documentation**

```bash
git add README.md docs
git commit -m "docs: declare REAL-1 commercial paper beta"
```

---

## Self-review

### Spec coverage

Covered:

- Architecture A and private-engine/public-control-plane boundary.
- 7-day REAL-1 entitlement source of truth.
- No-signer/no-private-key REAL-1 contract.
- Pairing-code flow.
- Ed25519 device identity.
- Signed sync, timestamp, replay protection.
- PostgreSQL control-plane entities.
- Real Solana RPC/WS health and public-wallet balance.
- Real opportunity source abstraction and initial program-log source.
- Current-official-doc verification gate for Solana and Jupiter APIs.
- Real quote adapter.
- Deterministic paper risk/positions/PnL.
- Stale quote handling.
- Local crash recovery that always restarts stopped.
- Local and Telegram STOP.
- Command/event idempotency.
- Six-view Telegram application shell.
- Simulator removal from authenticated product.
- Global product reality promotion only after code-backed proof.
- Packaging, `doctor`, customer workflow.
- Independent review, exact-SHA CI, Railway exact-SHA deploy, runtime evidence.
- Rollback data collected during release tasks.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, or undefined neighboring interface is intentionally left in the implementation path. Future live execution is explicitly a separate release, not a placeholder inside REAL-1.

### Type consistency

The plan consistently uses:

```text
EngineEntitlement
EngineSnapshotV1
EngineConfigV1
START_PAPER
STOP
UPDATE_SETTINGS
RESYNC
```

and the same runtime-state and live/paper semantics from the design.
