# REAL-1 Task 7/8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing paper engine into a tester-ready local runtime with normalized read-only Solana observations and a complete authenticated cloud sync protocol.

**Architecture:** The customer device remains the execution authority for PAPER mode. Read-only adapters produce validated `MarketObservation` values consumed by the existing `PaperEngine`; the cloud stores scoped snapshots/events and issues idempotent control commands over the existing signed outbound protocol. No private key, signer SDK, transaction constructor, or broadcast capability is introduced.

**Tech Stack:** TypeScript, Node.js >=22.13.0, Zod, PostgreSQL store, Hono API, Node test runner via `tsx`, HTTPS JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-08-17-real-1-paper-beta-design.md` and the approved REAL-1 blueprint in `C:\Users\AIWMC\.codex\attachments\d056615d-a00d-4518-b72f-0bcafe52923f\pasted-text.txt`.

## Global Constraints

- PAPER mode only; no signing, transaction construction, transaction broadcast, withdrawal, or custody.
- Telegram/Railway never receives a wallet secret; the engine sends outbound authenticated HTTPS only.
- All engine commands are account/device scoped, signed, timestamped, nonce-protected, idempotent, expiring, and auditable.
- Invalid, stale, duplicate, out-of-order, or mismatched market observations are rejected fail-closed.
- STOP remains available regardless of entitlement state.
- Every production behavior change requires a failing test first, then minimal implementation, then full regression tests.

---

### Task 1: Normalized market observation contracts

**Files:**
- Create: `engine/src/market.ts`
- Test: `engine/src/market.test.ts`
- Modify: `engine/src/contracts.ts`

**Interfaces:**
- Produces `MarketObservation`, `MarketSource`, `Freshness`, `normalizeObservation(input, nowMs)`, and `isFreshObservation(observation, nowMs, maxAgeMs)`.
- Consumes existing `PaperPrice`, `Network`, and Zod contract conventions.

- [ ] Write tests rejecting invalid mint, negative price, unsafe slot, future timestamps, and stale observations.
- [ ] Run `C:\Program Files\nodejs\npm.cmd --prefix engine test -- market.test.ts`; verify the new tests fail because the module is absent.
- [ ] Implement strict Zod validation, timestamp normalization, source latency calculation, and freshness classification.
- [ ] Run the focused market tests and then the complete engine test suite.
- [ ] Commit `feat: add normalized read-only market observations`.

### Task 2: Read-only adapter boundary and deduplication

**Files:**
- Create: `engine/src/market-adapters.ts`
- Test: `engine/src/market-adapters.test.ts`
- Modify: `engine/src/rpc.ts`

**Interfaces:**
- Produces `ReadOnlyMarketAdapter`, `RpcBalanceObservationAdapter`, `ObservationDeduplicator`, and `MarketObservationStream`.
- Adapters may call HTTPS read endpoints only and expose no signer/send/swap methods.

- [ ] Write tests proving adapters normalize confirmed RPC reads, reject network mismatch, deduplicate identical `(mint,slot,source)` observations, and reject out-of-order slots.
- [ ] Run focused tests and verify RED.
- [ ] Implement the adapter interface, bounded timeout/error mapping, and deterministic deduplication.
- [ ] Run focused and full engine tests plus `scripts/scan-real1-secrets.ts`.
- [ ] Commit `feat: enforce read-only market adapter boundary`.

### Task 3: Paper engine observation ingestion

**Files:**
- Modify: `engine/src/engine.ts`
- Modify: `engine/src/paper.ts`
- Test: `engine/src/engine.test.ts`

**Interfaces:**
- Adds `Engine.ingestObservation(observation)` and a bounded observation queue.
- Existing `EngineState` remains the snapshot consumed by the control loop.

- [ ] Write tests for fresh observation acceptance, stale observation rejection, duplicate suppression, and hard-stop behavior.
- [ ] Run focused tests and verify RED.
- [ ] Implement ingestion with max queue size, monotonic slot checks, and no synthetic activity when the feed is unavailable.
- [ ] Run all engine tests and frontend reality tests.
- [ ] Commit `feat: feed paper engine from validated observations`.

### Task 4: Durable customer runtime lifecycle

**Files:**
- Create: `engine/src/runtime.ts`
- Create: `engine/src/runtime.test.ts`
- Modify: `engine/src/cli.ts`
- Modify: `engine/package.json`

**Interfaces:**
- Produces `RuntimeState = UNCONFIGURED | READY | PAPER_RUNNING | PAUSED | STOPPED | DEGRADED | FAULTED` and `CustomerRuntime` methods `setup`, `doctor`, `startPaper`, `pause`, `stop`, `status`, `supportBundle`.
- Uses a local state file and single-instance lock; never stores private keys.

- [ ] Write tests for lifecycle transitions, persisted restart recovery, lock contention, bounded retry/backoff, graceful SIGINT stop, and fail-closed degraded state.
- [ ] Run focused tests and verify RED.
- [ ] Implement the runtime state machine, atomic snapshot writes, lock file, and CLI subcommands (`setup`, `status`, `paper start`, `paper pause`, `paper stop`, `support-bundle`, `version`).
- [ ] Run CLI smoke tests with a temporary directory and complete engine tests.
- [ ] Commit `feat: add durable customer runtime lifecycle`.

### Task 5: Authenticated sync protocol v2

**Files:**
- Modify: `engine/src/protocol.ts`
- Modify: `engine/src/authenticated-client.ts`
- Modify: `engine/src/control-loop.ts`
- Test: `engine/src/protocol.test.ts`
- Test: `engine/src/control-loop.test.ts`

**Interfaces:**
- Adds cloud-to-engine commands `paper_start`, `paper_pause`, `paper_stop`, `refresh_entitlement`, `request_snapshot`.
- Adds engine-to-cloud messages `heartbeat`, `snapshot`, `event_batch`, `command_ack`, `diagnostic_status`.
- Each command carries `command_id`, `installation_id`, `issued_at`, `expires_at`, `expected_state`, and payload.

- [ ] Write tests for signature/body binding, expiry, nonce replay, sequence protection, idempotent command processing, and STOP acceptance after entitlement expiry.
- [ ] Run focused tests and verify RED.
- [ ] Implement typed protocol envelopes and outbound sync methods while preserving existing HMAC headers.
- [ ] Run all engine tests and capability scan.
- [ ] Commit `feat: complete authenticated engine sync protocol`.

### Task 6: Cloud persistence and API semantics

**Files:**
- Modify: `src/engine-store.ts`
- Modify: `src/engine-auth.ts`
- Modify: `src/server.ts`
- Test: `test/engine-store.ts`
- Test: `test/engine-api.ts`

**Interfaces:**
- Adds scoped persistence for snapshots, event batches, command expiry/sequence, diagnostics, and support IDs.
- Adds API routes `/api/engine/sync`, `/api/engine/dashboard`, `/api/engine/events`, and command endpoints with explicit 401/409/410 responses.

- [ ] Write API/store tests for cross-account denial, replay rejection, expired commands, duplicate command idempotency, snapshot ordering, and event retention.
- [ ] Run tests and verify RED.
- [ ] Implement migrations and handlers using existing `EngineStore`, `authenticateEngineRequest`, and Telegram-to-internal-user resolution.
- [ ] Run backend typecheck, all backend tests, and the real smoke harness; external env absence must remain `REAL1_SMOKE_BLOCKED`, never silently pass.
- [ ] Commit `feat: persist and expose engine sync state`.

### Task 7: Telegram Mini App real-state dashboard

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `test/frontend-reality.ts`

**Interfaces:**
- Dashboard renders only backend-provided device, engine, RPC freshness, positions, exposure, PnL, and last event.
- Controls call authenticated cloud commands; STOP remains enabled whenever a paired device exists.

- [ ] Extend the shipped-JS VM test for connected snapshot rendering, stale RPC disclosure, command errors, and persistent STOP availability.
- [ ] Run frontend tests and verify RED for the new assertions.
- [ ] Implement rendering and bounded polling with explicit `UNAVAILABLE`/`EXECUTION DISABLED` fallback.
- [ ] Run the actual shipped frontend test, capability scan, and backend regression tests.
- [ ] Commit `feat: render live engine snapshots in Mini App`.

### Task 8: Tester documentation and release gates

**Files:**
- Modify: `docs/REAL1_CUSTOMER_SETUP.md`
- Modify: `docs/REAL1_OPERATOR_RUNBOOK.md`
- Create: `docs/REAL1_TASK7_8_EVIDENCE.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Documents exact local setup, pairing, runtime commands, read-only RPC requirements, failure states, support bundle collection, and re-certification checks.
- CI runs root typecheck/tests, engine tests, frontend shipped-JS tests, capability scan, and reports external smoke as blocked when credentials are absent.

- [ ] Write documentation tests/checks for required commands and security prohibitions.
- [ ] Run CI-equivalent commands locally and capture exact SHAs/results.
- [ ] Implement docs and evidence template; do not claim Railway/Telegram production verification without external evidence.
- [ ] Run final full suite and inspect `git diff --check`.
- [ ] Commit `docs: define REAL-1 Task 7/8 release evidence`.

## Release Gate

No merge or deployment is included in this plan. Completion means local implementation, passing reproducible tests, capability scan, and an explicit evidence record. Railway deployment, Telegram-context verification, and any REAL-2 wallet/live work require a separate user-approved release decision.
