# ARIA REAL-2 Sep 1 Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a controlled Sep 1 ARIA live beta in which a dedicated local Solana trading wallet is generated and retained only by `aria-engine`, while Telegram becomes the real authenticated control/status surface and all live execution passes explicit risk, confirmation and reconciliation gates.

**Architecture:** Keep the existing three-repository split. `aria-terminal-telegram` is UI only; `aria-telegram-BOT-APP` is identity/entitlement/command/audit; `aria-engine` owns local wallet authority and execution. Existing REAL-1 PAPER behavior remains intact and is never silently upgraded to LIVE.

**Tech Stack:** Node 22+, TypeScript, existing Postgres control plane, existing Telegram Mini App, existing signed engine/cloud protocol, Solana JSON-RPC, `@solana/kit` for new Solana transaction/signing primitives where required, Jupiter execution API behind a narrow adapter.

**Spec:** `docs/superpowers/specs/2026-08-24-aria-real2-local-wallet-design.md`

## Global Constraints

- Launch target: 2026-09-01 controlled live beta.
- Wallet secret exists only in local `aria-engine` storage/runtime.
- Never send seed/private material to Telegram, Railway, Vercel, Postgres or the Mini App.
- `DeviceAuthIdentity` and live trading wallet identity remain separate.
- Existing PAPER mode must keep working throughout development.
- All financial quantities use integer base units or explicit fixed-point values.
- No live execution before risk, idempotency, confirmation and restart-reconciliation gates exist.
- Local STOP remains available regardless of cloud/subscription/network state.
- Do not claim live readiness from source inspection; exact-SHA integration evidence is mandatory.

---

### Task 1: Dedicated Local Wallet Foundation

**Files:**
- Create: `aria-engine/src/live/trading-wallet.ts`
- Create: `aria-engine/src/live/trading-wallet-store.ts`
- Create: `aria-engine/src/live/trading-wallet.test.ts`
- Create: `aria-engine/src/live/trading-wallet-store.test.ts`
- Modify: `aria-engine/src/runtime/paths.ts`
- Modify: `aria-engine/src/solana-rpc.ts`
- Modify: `aria-engine/src/runtime/doctor.ts`
- Modify: `aria-engine/src/runtime/doctor.test.ts`
- Modify: `aria-engine/src/cli.ts`
- Modify: `aria-engine/package.json`

**Interfaces:**
- Produces `TradingWalletPublicState { address: string; createdAt: string; storageVersion: 1 }`.
- Produces `createTradingWallet()`, `loadTradingWallet()`, `getTradingWalletPublicState()`, and `getTradingWalletBalance()`.
- Does not expose any API that returns raw secret material to callers outside the isolated wallet module.

- [ ] **Step 1: Write failing separation tests**

Add tests proving the new module is distinct from `DeviceAuthIdentity`, wallet public state contains no private material, and a restart loads the same address rather than regenerating it.

- [ ] **Step 2: Run focused tests and prove RED**

Run:

```bash
npm run typecheck
npx tsx src/live/trading-wallet.test.ts
npx tsx src/live/trading-wallet-store.test.ts
```

Expected: tests fail because wallet modules do not exist.

- [ ] **Step 3: Implement local wallet creation and protected persistence**

Use a dedicated path under the existing ARIA runtime directory. Persist versioned encrypted/protected key material with restrictive filesystem permissions. Public-state getters return only the Solana address and metadata.

- [ ] **Step 4: Add read-only SOL balance support**

Reuse the existing Solana RPC transport. Return lamports as `bigint` or decimal strings at serialization boundaries. RPC failure must never become a fake zero balance.

- [ ] **Step 5: Add CLI/doctor surfaces**

Add customer-safe operations such as:

```text
aria wallet status
aria wallet create
aria wallet address
```

Do not add seed export/import commands for the Sep 1 beta. Doctor reports wallet existence, address and balance-read readiness without printing secret material.

- [ ] **Step 6: Run full regression and secret-boundary scan**

```bash
npm run typecheck
npm test
git diff --check
```

Inspect all new sync/log/status serialization paths and prove the secret is absent.

- [ ] **Step 7: Commit**

```bash
git add src/live src/runtime/paths.ts src/runtime/doctor.ts src/runtime/doctor.test.ts src/solana-rpc.ts src/cli.ts package.json
git commit -m "feat(live): add dedicated local ARIA trading wallet foundation"
```

**Gate:** Task 1 is complete only when the same public wallet address survives a real process restart and real Solana balance lookup works without any signing/broadcast path being enabled.

---

### Task 2: Live Execution Domain and Fail-Closed State Machine

**Files:**
- Create: `aria-engine/src/live/execution-types.ts`
- Create: `aria-engine/src/live/execution-state.ts`
- Create: `aria-engine/src/live/execution-state.test.ts`
- Create: `aria-engine/src/live/live-risk.ts`
- Create: `aria-engine/src/live/live-risk.test.ts`
- Create: `aria-engine/src/live/execution-store.ts`
- Create: `aria-engine/src/live/execution-store.test.ts`

**Interfaces:**
- Produces `TradeIntent`, `RiskDecision`, `ExecutionQuote`, `ExecutionAttempt`, `ChainTransaction`, `Fill`, and `LivePosition`.
- Produces forward-only execution state transitions.
- Produces `evaluateLiveRisk(intent, state, limits, marketObservation)`.

- [ ] **Step 1: Write failing state-machine tests**

Test permitted progression:

```text
created -> risk_approved -> quoted -> simulated -> signed -> broadcast -> confirmation_pending -> confirmed -> reconciled
```

Test terminal/failure branches including `risk_rejected`, `quote_expired`, `failed_prebroadcast`, and `broadcast_unknown`.

- [ ] **Step 2: Prove RED**

Run focused test files; expect missing symbols/modules.

- [ ] **Step 3: Implement immutable intent and forward-only transitions**

Every intent has an idempotency key. A repeated identical intent returns/reuses the original execution record; a reused key with different economic parameters is rejected.

- [ ] **Step 4: Implement live risk evaluation**

Enforce integer-based limits for max trade, total exposure, positions, daily realized loss, fee reserve, slippage budget, stale data, source disagreement, and mint allow/deny controls.

- [ ] **Step 5: Implement durable local execution store**

Persist intents, attempts, submitted signatures, fills, positions, daily counters and processed command IDs. State updates must be atomic enough that an abrupt process kill cannot make a signed/broadcast transaction disappear from recovery state.

- [ ] **Step 6: Regression and commit**

```bash
npm run typecheck
npm test
git diff --check
git commit -m "feat(live): add execution state machine and risk domain"
```

**Gate:** no transaction-signing adapter is wired until Task 2 state, idempotency and risk tests are green.

---

### Task 3: Jupiter Quote, Preflight and Bounded Mainnet Execution Adapter

**Files:**
- Create: `aria-engine/src/live/jupiter-execution.ts`
- Create: `aria-engine/src/live/jupiter-execution.test.ts`
- Create: `aria-engine/src/live/solana-signer.ts`
- Create: `aria-engine/src/live/solana-signer.test.ts`
- Create: `aria-engine/src/live/confirmation.ts`
- Create: `aria-engine/src/live/confirmation.test.ts`
- Modify: `aria-engine/package.json`

**Interfaces:**
- Consumes `TradeIntent`, `RiskDecision`, and the isolated trading-wallet module.
- Produces bounded quotes/execution attempts and chain-confirmation results.
- External-provider details stay behind the adapter; the rest of the engine never calls Jupiter directly.

- [ ] **Step 1: Verify current provider API contract before coding**

Use current official Jupiter documentation and a read-only probe. Record the exact endpoint/version in the adapter docblock and tests. Do not guess historical endpoint shapes.

- [ ] **Step 2: Write failing quote/parsing tests with deterministic fixtures**

Cover integer input/output amounts, route expiry, slippage bound, provider errors and malformed payloads.

- [ ] **Step 3: Implement quote adapter without signing**

Quote retrieval must be independently testable. A quote outside configured risk bounds is rejected before any signer is invoked.

- [ ] **Step 4: Write signer-isolation tests**

Prove only the isolated local wallet adapter can request a transaction signature and that no secret is returned to execution-domain callers.

- [ ] **Step 5: Implement preflight + broadcast uncertainty semantics**

A prebroadcast failure can fail cleanly. Once a transaction is signed/submitted, network timeout becomes `broadcast_unknown`/`confirmation_pending`, never an automatic retry.

- [ ] **Step 6: Implement confirmation/finality reconciliation**

Track signature, blockhash validity metadata, confirmation state and actual token/SOL balance changes. Confirmed fills derive from chain evidence, not quoted estimates.

- [ ] **Step 7: Run tiny-value internal mainnet proof**

Use a newly generated dedicated wallet funded with a deliberately tiny amount. Prove one buy and one sell, record transaction signatures and exact before/after base-unit balances. Do not expose private material in test logs.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(live): add bounded Solana swap execution and confirmation"
```

**Gate:** no automated strategy loop is allowed to call this adapter until the tiny-value manually triggered buy/sell path and reconciliation are verified.

---

### Task 4: Live Supervisor, Hard Stop and Restart Recovery

**Files:**
- Create: `aria-engine/src/live/live-supervisor.ts`
- Create: `aria-engine/src/live/live-supervisor.test.ts`
- Create: `aria-engine/src/live/recovery.ts`
- Create: `aria-engine/src/live/recovery.test.ts`
- Modify: `aria-engine/src/sync/command-handler.ts`
- Modify: `aria-engine/src/cli.ts`
- Modify: `aria-engine/src/runtime/doctor.ts`

**Interfaces:**
- Produces explicit `LIVE_DISABLED | LIVE_READY | LIVE_RUNNING | LIVE_PAUSED | LIVE_STOPPED | LIVE_DEGRADED | LIVE_FAULTED` state.
- Remote commands can request state changes; local supervisor applies them only after local readiness/risk checks.

- [ ] **Step 1: Write failing supervisor tests**

Prove LIVE start cannot occur unless wallet, entitlement, RPC, market, persistence and risk readiness are all green. Prove STOP always succeeds locally even if cloud/network/entitlement are unavailable.

- [ ] **Step 2: Implement supervisor with explicit enable step**

LIVE mode requires an operator-controlled enable flag/state separate from PAPER. Never infer LIVE from existence of a funded wallet.

- [ ] **Step 3: Implement recovery-before-retry**

On startup, reconcile all unresolved signed/broadcast transactions before accepting new intents. Duplicate command/intent IDs must not produce duplicate chain execution.

- [ ] **Step 4: Crash-test**

Terminate the process after transaction submission but before local confirmation persistence. Restart and prove the same signature is reconciled instead of rebroadcasting a duplicate.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(live): add supervisor hard stop and chain recovery"
```

---

### Task 5: Control-Plane Live State Contract

**Files:**
- Modify/Create in `aria-telegram-BOT-APP` following current engine snapshot/event/command patterns.
- Extend existing engine sync schema rather than creating a parallel transport.
- Test through existing signed device-auth protocol and Postgres self-tests.

**Interfaces:**
- Engine -> cloud: wallet public state, live readiness, balances, positions, fills, transaction signatures, risk events.
- Cloud -> engine: `live_enable`, `live_start`, `live_pause`, `live_stop`, `request_snapshot` commands.

- [ ] **Step 1: Extend typed sync contracts with versioned live payloads**

No wallet authority or opaque secret blobs are valid fields.

- [ ] **Step 2: Add Postgres storage/read APIs for latest real engine state**

Reuse existing `engine_snapshots`, `engine_events`, `engine_commands` instead of creating a second event system unless a proven schema limitation requires a migration.

- [ ] **Step 3: Add authenticated user-facing status endpoints**

Telegram identity comes from verified `initData`; users can retrieve only their own paired engine/device state.

- [ ] **Step 4: Add command authorization and audit**

START/PAUSE/STOP must record user/device/command timestamps and outcomes. STOP remains deliverable regardless of active trading entitlement, subject only to authenticated ownership of the device.

- [ ] **Step 5: Run real Postgres + signed-device integration tests**

Prove cross-user isolation, idempotent command delivery, state update, and STOP priority.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(live): expose authenticated engine state and controls"
```

---

### Task 6: Replace Demo Terminal with Real Authenticated State

**Files:**
- Modify: `aria-terminal-telegram/index.html`
- Modify: `aria-terminal-telegram/app.js`
- Modify: `aria-terminal-telegram/styles.css`
- Modify/Create: `aria-terminal-telegram/api/*` only as a thin proxy/auth layer if required; prefer calling canonical control-plane APIs.
- Modify: `aria-terminal-telegram/tests/*`
- Update: `aria-terminal-telegram/README.md`

**Interfaces:**
- UI consumes sanitized authenticated control-plane state only.
- UI never calculates financial truth independently.

- [ ] **Step 1: Write frontend tests proving simulated data is gone from authenticated mode**

The current demo terminal must not show fabricated detections, fills, positions or PnL when an authenticated real account is loaded.

- [ ] **Step 2: Wire account/license/device state**

Show ACTIVE/EXPIRED/REVOKED, paired device, last-seen and engine readiness. No `.env` instructions or raw token handling in the normal customer flow.

- [ ] **Step 3: Add wallet/funding surface**

Show public address, real SOL balance, copy and QR. `FUND WALLET` only exposes the user's self-custodied address.

- [ ] **Step 4: Wire live state and controls**

Render real mode, risk limits, positions, PnL, recent events/fills and explorer links. START/PAUSE/STOP call authenticated control-plane command endpoints.

- [ ] **Step 5: Preserve explicit non-ready states**

If the engine is offline, unpaired, unfunded, stale, paused, revoked or degraded, show that exact state instead of substituting demo activity.

- [ ] **Step 6: Cross-client test**

Verify Telegram Desktop, Android and iOS safe-area/layout behavior against the real authenticated flow.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(terminal): replace demo state with real ARIA engine control UI"
```

---

### Task 7: Exact-SHA Release Certification

**Files:**
- Update: `docs/REAL2_EXECUTION_STATE.md`
- Create: `docs/REAL2_RELEASE_CERTIFICATION_2026-09-01.md`
- Add/update repository CI/release workflow files where required.

- [ ] **Step 1: Freeze release candidates**

Record exact SHAs for all three repositories. No feature work after freeze without invalidating certification.

- [ ] **Step 2: Run clean-machine setup**

Fresh supported machine -> install engine -> Telegram login -> `/pair` -> wallet creation -> fund tiny amount -> doctor/readiness green.

- [ ] **Step 3: Run end-to-end controlled live cycle**

Prove real market observation, bounded buy, confirmation, position state, bounded sell, final balance and PnL reconciliation.

- [ ] **Step 4: Run failure matrix**

Test RPC timeout, provider outage, stale market data, price disagreement, control-plane outage, duplicate commands, process kill during pending transaction, entitlement revocation, insufficient fee reserve and local STOP.

- [ ] **Step 5: Run soak**

At least 72 hours of PAPER/observation/control-plane operation and a controlled live-money window using the release candidate; capture crash/reconnect/duplicate/reconciliation metrics.

- [ ] **Step 6: Verify release artifacts and provenance**

Record exact source SHAs, Node/runtime versions, dependency audit, secret scan, checksums, release notes, rollback procedure and production URLs.

- [ ] **Step 7: Final launch decision**

Only mark `REAL-2 CONTROLLED LIVE BETA = READY` if every required money-integrity, STOP and recovery gate is evidenced. Otherwise launch remains PAPER/internal until the failed gate is closed.

---

## Plan Self-Review

- Spec coverage: custody boundary, wallet, execution, risk, sync, terminal, recovery and release certification each have explicit tasks.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: live domain objects are defined in Task 2 and consumed by later tasks under the same names.
- Scope: seven independently reviewable slices; each produces testable software and can be rejected without invalidating unrelated earlier slices.
