# REAL-1 Paper Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a non-custodial local ARIA Engine and a Telegram Control Center for a commercially usable, explicitly paper-only beta.

**Architecture:** Railway stays an authenticated control plane. The customer-run engine owns local configuration, licence validation, public-balance RPC reads, paper state, and STOP; it calls the control plane outbound only. The Mini App renders backend-relayed engine data and never fabricates operational activity.

**Tech Stack:** Node.js >=22.13, TypeScript ESM, Hono, PostgreSQL/node-pg-migrate, Node crypto, JSON-RPC fetch, browser JavaScript, GitHub Actions, Railway.

## Global Constraints

- Begin only after PR #3 has merged and its FREE-1A merge SHA has passed production verification.
- REAL-1 must not construct, sign, serialize, or broadcast a Solana transaction.
- No private key, seed phrase, wallet file, RPC URL, licence token, or device credential is logged, displayed, returned, or persisted by the control plane.
- The engine has no inbound listener; all engine traffic is outbound HTTPS.
- Engine requests carry device credential, timestamp, nonce, body SHA-256, and HMAC-SHA-256 signature.
- Every Mini App API request derives its user from verified Telegram `initData`.
- Operational UI shows `PAPER — NO REAL ORDERS`; malformed or stale data shows `UNAVAILABLE` and starts no generated activity.
- Amount authorities use integer base units; all persisted balances and quantities are integers.
- Every task uses a failing test, exact test run, focused commit, and reviewer gate.

---

## Task 1: PostgreSQL control-plane domain

**Files:**
- Create: `migrations/1770000000000_real1_control_plane.ts`
- Create: `src/control-plane.ts`
- Test: `test/real1-control-plane.ts`

**Interfaces:**

```ts
export interface EngineState { controlState: "stopped" | "paper_running"; network: string; publicAddress: string; balanceLamports: bigint; }
export interface Dashboard { devices: Array<{ id: string; status: "connected" | "disconnected" | "revoked"; state: EngineState | null }>; events: SanitizedEvent[]; }
export async function createPairingCode(userId: number, now: Date): Promise<{ code: string; expiresAt: string }>;
export async function pairDevice(input: PairDeviceInput): Promise<{ deviceId: string; credential: string }>;
export async function listDashboard(userId: number, now: Date): Promise<Dashboard>;
```

- [ ] **Step 1: Write the failing domain test.**

```ts
const pairing = await createPairingCode(1, NOW);
assert.match(pairing.code, /^[A-Z2-9]{8}$/);
await assert.rejects(() => pairDevice({ code: pairing.code, deviceName: "x", publicAddress: "bad" }), /invalid|expired/i);
assert.equal((await listDashboard(2, NOW)).devices.length, 0);
```

- [ ] **Step 2: Run RED.** Run `npx tsx test/real1-control-plane.ts`. Expected: FAIL because the module and tables do not exist.
- [ ] **Step 3: Implement the migration and module.** Create `real1_pairing_codes` with hashed single-use code, `real1_devices` with hashed credential and public address, `real1_commands` with per-device idempotency key, and `real1_events` with bounded allow-listed payload. Foreign-key every row to `users(id)`. Store neither plaintext code nor credential.
- [ ] **Step 4: Run GREEN.** Run `npx tsx test/real1-control-plane.ts && npm run typecheck`. Expected: PASS; add a direct database assertion that code and credential plaintext are absent.
- [ ] **Step 5: Commit.** Run `git add migrations src/control-plane.ts test/real1-control-plane.ts` then `git commit -m "feat: add REAL-1 control-plane domain"`.

## Task 2: Signed engine protocol and replay protection

**Files:**
- Create: `src/engine-auth.ts`
- Modify: `src/control-plane.ts`
- Test: `test/real1-engine-auth.ts`

**Interfaces:**

```ts
export interface EngineSignature { timestamp: string; nonce: string; bodyHash: string; signature: string; }
export function signEngineRequest(credential: string, method: string, path: string, timestamp: string, nonce: string, body: string): EngineSignature;
export async function verifyEngineRequest(input: VerifyEngineRequest): Promise<VerifiedDevice | null>;
```

- [ ] **Step 1: Write the failing adversarial test.**

```ts
assert.equal((await verifyEngineRequest(validRequest))?.id, device.id);
assert.equal(await verifyEngineRequest({ ...validRequest, nonce: validRequest.nonce }), null);
assert.equal(await verifyEngineRequest({ ...validRequest, timestamp: OLD }), null);
assert.equal(await verifyEngineRequest({ ...validRequest, signature: "00" }), null);
```

- [ ] **Step 2: Run RED.** Run `npx tsx test/real1-engine-auth.ts`. Expected: FAIL because request authentication does not exist.
- [ ] **Step 3: Implement canonical verification.** Sign `METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA256(BODY)` with HMAC-SHA-256. Reject timestamps outside five minutes, body mismatch, invalid hex, revoked device, missing credential hash, and duplicate `(device_id, nonce)`. Use equal-length validation plus `timingSafeEqual`; insert nonce transactionally before mutation.
- [ ] **Step 4: Run GREEN.** Run `npx tsx test/real1-engine-auth.ts && npm run test`. Expected: PASS for replay, forgery, expiry, revocation, and cross-account denial.
- [ ] **Step 5: Commit.** Run `git add src/engine-auth.ts src/control-plane.ts test/real1-engine-auth.ts` then `git commit -m "feat: authenticate REAL-1 engine requests"`.

## Task 3: Account-scoped control-plane API

**Files:**
- Modify: `src/server.ts`
- Create: `test/real1-api.ts`
- Modify: `test/e2e.ts`

**Interfaces:**

```text
POST /api/real1/pairing-codes
GET  /api/real1/dashboard
POST /api/real1/devices/:id/revoke
POST /api/real1/devices/:id/commands
POST /api/real1/engine/pair
POST /api/real1/engine/heartbeat
POST /api/real1/engine/events
GET  /api/real1/engine/commands
```

- [ ] **Step 1: Write failing HTTP tests.**

```ts
assert.equal((await app.request("/api/real1/dashboard")).status, 400);
assert.equal((await app.request("/api/real1/dashboard", telegramHeaders(userA))).status, 200);
assert.equal((await app.request(`/api/real1/devices/${deviceB}/commands`, telegramHeaders(userA), postStop)).status, 404);
assert.equal((await app.request("/api/real1/engine/heartbeat", signedHeaders, postState)).status, 204);
```

- [ ] **Step 2: Run RED.** Run `npx tsx test/real1-api.ts`. Expected: FAIL because routes do not exist.
- [ ] **Step 3: Implement narrow routes.** Use `verifyInitData` and `upsertUserFromTelegram` for Mini App routes. Accept only `start_paper`, `stop`, and `update_strategy`; reject any live enum. Validate device names to 64 characters, events to fixed kinds plus a 512-character message, public keys to base58 length, and strategy bounds from Task 5. Return `404` for another user’s device.
- [ ] **Step 4: Run GREEN.** Run `npx tsx test/real1-api.ts && npm run test && npm run typecheck`. Expected: PASS and JSON snapshots contain none of `credential`, `code`, `rpcUrl`, or licence token.
- [ ] **Step 5: Commit.** Run `git add src/server.ts test/e2e.ts test/real1-api.ts` then `git commit -m "feat: add REAL-1 control-plane API"`.

## Task 4: Local engine safety foundation

**Files:**
- Create: `packages/aria-engine/package.json`
- Create: `packages/aria-engine/src/config.ts`
- Create: `packages/aria-engine/src/license.ts`
- Create: `packages/aria-engine/src/safety.ts`
- Create: `packages/aria-engine/test/config-safety.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export function loadEngineConfig(path: string): EngineConfig;
export function redactConfig(config: EngineConfig): RedactedConfig;
export class StopLatch { stop(reason: string): void; assertPaperAction(): void; }
export function validateLocalLicense(token: string, publicKey: string, now: Date): ValidLicense;
```

- [ ] **Step 1: Write the failing local safety test.**

```ts
assert.throws(() => loadEngineConfig("bad.json"), /rpcUrl|walletPath|strategy/i);
assert.equal(JSON.stringify(redactConfig(validConfig)).includes("secret"), false);
latch.stop("license_expired");
assert.throws(() => latch.assertPaperAction(), /stopped/i);
assert.throws(() => validateLocalLicense(expiredToken, publicKey, NOW), /expired/i);
```

- [ ] **Step 2: Run RED.** Run `npm --prefix packages/aria-engine test`. Expected: FAIL because the engine package is absent.
- [ ] **Step 3: Implement config and safety.** Require local `controlPlaneUrl`, `rpcUrl`, `walletPath`, `licenseToken`, `deviceCredentialPath`, and bounded strategy. Redact all secret fields. Reject group/world-readable secret files on Unix; emit a Windows ACL remediation diagnostic without changing ACLs. Reuse the current Ed25519 licence verification format locally. Start the STOP latch engaged.
- [ ] **Step 4: Run GREEN.** Add `test:engine` to root scripts; run `npm --prefix packages/aria-engine test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Run `git add package.json packages/aria-engine` then `git commit -m "feat: add REAL-1 engine safety foundation"`.

## Task 5: Read-only RPC and paper state machine

**Files:**
- Create: `packages/aria-engine/src/rpc.ts`
- Create: `packages/aria-engine/src/strategy.ts`
- Create: `packages/aria-engine/src/paper.ts`
- Create: `packages/aria-engine/test/rpc-paper.ts`

**Interfaces:**

```ts
export async function readNetworkAndBalance(config: EngineConfig): Promise<{ cluster: string; publicAddress: string; balanceLamports: bigint }>;
export function validateStrategy(input: unknown): Strategy;
export class PaperBook { apply(event: PaperEvent): PaperSnapshot; }
```

- [ ] **Step 1: Write the failing paper/RPC test.**

```ts
book.apply({ type: "detected", opportunity });
assert.equal(book.apply({ type: "paper_filled", orderId }).positions.length, 1);
assert.throws(() => validateStrategy({ maxOpenPositions: 0 }), /maxOpenPositions/i);
await assert.rejects(() => readNetworkAndBalance(badRpc), /rpc/i);
```

- [ ] **Step 2: Run RED.** Run `npm --prefix packages/aria-engine run test:paper`. Expected: FAIL because modules do not exist.
- [ ] **Step 3: Implement read-only modules.** Use only `getGenesisHash` and `getBalance` JSON-RPC calls. Use `BigInt` lamports. Implement immutable `detected -> rejected|queued -> paper_filled -> closed` events and explicit paper positions/PnL. Enforce positive integer positions, positive lamport buy cap, 0–10000 bps slippage, 0–100% stop/TP, and non-negative token age/liquidity.
- [ ] **Step 4: Run GREEN and no-execution scan.** Run `npm --prefix packages/aria-engine run test:paper && rg -n "sendTransaction|signTransaction|VersionedTransaction|TransactionInstruction" packages/aria-engine/src`. Expected: test PASS; `rg` returns no matches.
- [ ] **Step 5: Commit.** Run `git add packages/aria-engine/src packages/aria-engine/test/rpc-paper.ts` then `git commit -m "feat: add REAL-1 paper engine domain"`.

## Task 6: Outbound engine client and command loop

**Files:**
- Create: `packages/aria-engine/src/control-client.ts`
- Create: `packages/aria-engine/src/index.ts`
- Create: `packages/aria-engine/test/control-client.ts`

**Interfaces:**

```ts
export class ControlClient { heartbeat(state: EngineState): Promise<void>; events(events: SanitizedEvent[]): Promise<void>; nextCommands(): Promise<Command[]>; }
export class Engine { run(): Promise<void>; handle(command: Command): Promise<CommandAck>; snapshot(): EngineState; }
```

- [ ] **Step 1: Write the failing protocol test.**

```ts
await engine.handle({ id: "1", type: "start_paper" });
assert.equal(engine.snapshot().controlState, "paper_running");
await engine.handle({ id: "2", type: "stop" });
assert.equal(engine.snapshot().controlState, "stopped");
await assert.rejects(() => engine.handle({ id: "3", type: "live" } as never), /command/i);
```

- [ ] **Step 2: Run RED.** Run `npm --prefix packages/aria-engine run test:client`. Expected: FAIL because client and engine do not exist.
- [ ] **Step 3: Implement outbound-only lifecycle.** Sign every request exactly as Task 2 verifies. Poll commands on a bounded interval, acknowledge idempotently, and heartbeat bounded state. Stop on invalid API response, licence failure, unsafe strategy, RPC failure, or stale control session. CLI commands are exactly `init`, `pair`, `validate`, and `run`; `run` begins stopped.
- [ ] **Step 4: Run GREEN.** Run `npm --prefix packages/aria-engine run test:client && npm --prefix packages/aria-engine test && npm run test`. Expected: PASS; assert source contains no `listen(`, `createServer(`, or inbound web framework import.
- [ ] **Step 5: Commit.** Run `git add packages/aria-engine/src packages/aria-engine/test/control-client.ts` then `git commit -m "feat: connect REAL-1 engine to control plane"`.

## Task 7: REAL-1 Telegram Control Center

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `test/frontend-real1.ts`

**Interfaces:**

```text
Dashboard states: setup_required | disconnected | connected_paper | stopped | revoked
Commands: start_paper | stop | update_strategy
Views: Setup | Controls | Operations | Activity | Positions
```

- [ ] **Step 1: Write a failing shipped-JavaScript test.**

```ts
const disconnected = await runShippedApp({ dashboard: { devices: [] } });
assert.match(disconnected.text("connection"), /DISCONNECTED/);
assert.equal(disconnected.text("feed-count"), "0 events");
const connected = await runShippedApp({ dashboard: connectedPaperDashboard });
assert.match(connected.text("reality-banner"), /PAPER — NO REAL ORDERS/);
assert.equal(connected.click("start-paper").request.body.type, "start_paper");
```

- [ ] **Step 2: Run RED.** Run `npx tsx test/frontend-real1.ts`. Expected: FAIL because the existing page is not a control center.
- [ ] **Step 3: Implement data-driven views.** Replace generated events/timers with dashboard API data. Require active paired device before enabling controls. Apply four-second fetch timeout; on failure clear all state and render `UNAVAILABLE`. Show only shortened public address and display-only formatted lamports. Include no live control or live execution copy.
- [ ] **Step 4: Run GREEN.** Run `npx tsx test/frontend-real1.ts && npm run test && npm run typecheck`. Expected: PASS; VM test executes actual `public/app.js` and proves no activity after stale/disconnected state.
- [ ] **Step 5: Commit.** Run `git add public test/frontend-real1.ts` then `git commit -m "feat: add REAL-1 Telegram control center"`.

## Task 8: Onboarding, CI, and release evidence

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `packages/aria-engine/README.md`
- Modify: `.github/workflows/ci.yml`
- Create: `test/real1-smoke.ts`

**Interfaces:**

```text
CLI: aria-engine init | pair | validate | run
Opt-in smoke env: ARIA_REAL1_SMOKE_RPC_URL, ARIA_REAL1_SMOKE_WALLET_PUBLIC_ADDRESS
```

- [ ] **Step 1: Write the failing smoke/CI test.**

```ts
assert.equal(process.env.ARIA_REAL1_SMOKE_RPC_URL?.startsWith("https://"), true);
const state = await readNetworkAndBalance(smokeConfig);
assert.ok(state.balanceLamports >= 0n);
assert.equal(engine.snapshot().controlState, "stopped");
```

- [ ] **Step 2: Run the smoke test without inputs.** Run `npm run test:real1-smoke`. Expected: PASS with `SKIPPED: explicit smoke inputs absent`; default CI makes no RPC request.
- [ ] **Step 3: Document and automate evidence.** Document install, local-secret boundary, pairing, revoke, STOP recovery, and paper-only limitation. Add CI checks for typecheck, backend/engine/frontend tests, static no-signing scan, and secret-pattern scan. CI receives no private key or licence token.
- [ ] **Step 4: Run all gates.** Run `npm ci && npm run typecheck && npm test && npm run test:real1-smoke`. Expected: PASS; controlled smoke is run separately with only HTTPS RPC URL and public address and records sanitized network/balance output.
- [ ] **Step 5: Commit and perform release closure.** Run `git add README.md .env.example .github/workflows/ci.yml packages/aria-engine/README.md test/real1-smoke.ts` then `git commit -m "docs: add REAL-1 paper beta release gate"`. Obtain independent review, merge, capture merge SHA, poll CI for it, verify Railway health/control routes, pair a controlled engine, verify Telegram connected-paper rendering, issue STOP, and verify stopped rendering.

## Plan Self-Review

- Coverage: Tasks 1–3 implement pairing, persistence, ownership, sanitization, commands, and signed protocol. Tasks 4–6 implement local secret handling, licence/STOP enforcement, read-only RPC, paper state, and outbound client lifecycle. Task 7 replaces demo behavior with the real control center. Task 8 covers onboarding, CI, smoke evidence, and release verification.
- Placeholder scan: this plan contains no `TODO`, `TBD`, unspecified error handler, or deferred implementation instruction.
- Interface consistency: device ids, command ids, `EngineState`, `Dashboard`, `Strategy`, `SanitizedEvent`, and `balanceLamports: bigint` are used consistently across tasks.

## Execution Handoff

Plan complete: `docs/superpowers/plans/2026-08-17-real-1-paper-beta.md`.

Execution is inline in this session using `superpowers:executing-plans`; project policy prohibits subagent delegation. Execute one committed task at a time and pause for a user-visible verification checkpoint after each task.
