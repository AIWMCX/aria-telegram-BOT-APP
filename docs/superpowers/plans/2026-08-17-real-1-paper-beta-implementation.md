# REAL-1 Local Engine and Telegram Control Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a commercially usable, non-custodial ARIA paper-trading beta with a local engine, paired Telegram control center, real Solana RPC reads, licence enforcement, and fail-closed controls.

**Architecture:** The existing Hono service remains the Railway control plane. A new `engine/` package runs outbound-only on the customer computer, keeps wallet/RPC secrets local, and reports sanitized paper state. The Mini App uses Telegram-authenticated control-plane endpoints; the engine uses a separate device-credential protocol.

**Tech Stack:** Node.js `>=22.13.0`, TypeScript, Hono, Zod, PostgreSQL for REAL-1 control-plane records, existing SQLite licence product, Solana JSON-RPC over HTTPS, Node `crypto`, and the existing Node VM frontend test style.

## Global Constraints

- No private key, seed phrase, wallet file, or RPC URL is uploaded to ARIA, emitted in logs, returned by an API, or rendered in the Mini App.
- The engine has no inbound HTTP listener; it makes outbound connections to ARIA only.
- Every engine request has a device credential, timestamp, nonce, and request-body integrity value; replayed, expired, malformed, or revoked requests are rejected.
- Telegram identity is always derived from verified `initData`.
- REAL-1 has only `start_paper`, `stop`, and `update_strategy` commands.
- `PAPER — NO REAL ORDERS` is persistent whenever REAL-1 data is shown.
- REAL-1 contains no transaction construction, signing, broadcasting, DEX routing, deposits, withdrawals, custody, pooled balances, or live execution.
- Paper amounts and PnL are clearly labelled; no paper result is presented as account activity or trading performance.
- Existing licence, payment, and FREE-1A behavior remains intact.

---

## Repository map and ownership

| Area | Files | Responsibility |
|---|---|---|
| Engine package | `engine/package.json`, `engine/tsconfig.json`, `engine/src/*.ts` | Local configuration, licence check, pairing, RPC read, paper state, outbound protocol, local STOP |
| Control plane | `src/engine-control.ts`, `src/engine-auth.ts`, `src/engine-store.ts`, `src/server.ts` | Pairing, device credentials, commands, heartbeat/state/event ingestion, account isolation |
| PostgreSQL migrations | `migrations/*.sql` or existing migration location | Users/devices/commands/state/events/strategy constraints |
| Mini App | `public/index.html`, `public/app.js`, `public/styles.css` | Setup, controls, status, paper activity, positions, persistent disclosures |
| Tests | `test/engine-*.ts`, `test/frontend-reality.ts`, `test/e2e.ts` | Unit, API isolation, protocol, real shipped-JS, and smoke evidence |
| Operations | `.env.example`, `README.md`, CI workflow | Installation, secrets policy, CI and Railway checks |

### Task 1: Create the engine package contract

**Files:**
- Create: `engine/package.json`
- Create: `engine/tsconfig.json`
- Create: `engine/src/contracts.ts`
- Create: `engine/src/contracts.test.ts`
- Modify: root `package.json`

**Interfaces:**
- Produces `EngineState`, `EngineCommand`, `StrategyConfig`, `PaperEvent`, `SanitizedHeartbeat`, and `EngineErrorCode` for every later engine module.
- `EngineState` has `status: "stopped" | "starting" | "paper_running" | "stopping"`, `network: "unknown" | "solana-devnet" | "solana-mainnet"`, `publicAddress: string | null`, `balanceLamports: bigint | null`, `licenseStatus: "valid" | "expired" | "invalid"`, `strategy: StrategyConfig`, `lastHeartbeatAt: string | null`, and `paper: { positions: PaperPosition[]; pnlLamports: bigint }`.
- `EngineCommand` is `{ id: string; type: "start_paper" | "stop" | "update_strategy"; issuedAt: string; expiresAt: string; payload: unknown }`.

- [ ] **Step 1: Write the failing contract tests.** Assert that Zod schemas accept a bounded paper configuration, reject `live`, reject non-finite numbers, reject unknown command types, and serialize no secret fields.
- [ ] **Step 2: Run the focused test.** Run `npm run test:engine-contract`; expect failure because the engine package and schemas do not exist.
- [ ] **Step 3: Implement the package and schemas.** Add the package scripts `typecheck`, `test`, and `start`; use Zod schemas with explicit enums and finite numeric bounds; represent lamports as decimal strings at transport boundaries and `bigint` internally.
- [ ] **Step 4: Run the focused test and typecheck.** Run `npm run test:engine-contract` and `npm run typecheck:engine`; both must pass.
- [ ] **Step 5: Commit.** `git add engine package.json && git commit -m "feat: define REAL-1 engine contracts"`.

### Task 2: Implement local configuration, redaction, and licence enforcement

**Files:**
- Create: `engine/src/config.ts`
- Create: `engine/src/license.ts`
- Create: `engine/src/config.test.ts`
- Create: `engine/src/license.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- `loadEngineConfig(env: NodeJS.ProcessEnv): EngineConfig` rejects unknown/invalid modes and requires a local wallet reference and RPC URL without returning secret values.
- `redactEngineConfig(config: EngineConfig): Record<string, string>` returns only safe diagnostic keys.
- `validateLicense(token: string, publicKeyX: string, now: Date): LicenseResult` returns `{ status, tier, expiresAt }` and never returns the token.

- [ ] **Step 1: Write tests for redaction and expiry.** Verify a private-key-looking value and RPC URL never occur in redacted output; verify valid, expired, malformed, and tampered ARIA licence tokens produce distinct statuses; verify paper mode is the only accepted execution mode.
- [ ] **Step 2: Run tests to confirm RED.** Run `npm run test:engine-config`; expect missing-module failures.
- [ ] **Step 3: Implement config and licence modules.** Reuse the existing licence verification format through a narrow adapter; read wallet path/OS-keystore reference locally; reject seed phrases and raw private-key environment variables; make every diagnostic value allow-listed.
- [ ] **Step 4: Add operator documentation.** Document local-only variables, file permissions, startup command, and explicit no-live guarantee in `.env.example` and `README.md`.
- [ ] **Step 5: Run tests and typecheck.** Run `npm run test:engine-config` and `npm run typecheck:engine`.
- [ ] **Step 6: Commit.** `git add engine/src/config.ts engine/src/license.ts engine/src/*.test.ts .env.example README.md && git commit -m "feat: enforce local engine configuration and licence"`.

### Task 3: Add PostgreSQL control-plane records and account-scoped storage

**Files:**
- Create: `migrations/REAL1_001_engine_control.sql` using the repository’s configured migration tool
- Create: `src/engine-store.ts`
- Create: `test/engine-store.ts`
- Modify: `src/db-pg.ts` only where migration execution requires it

**Interfaces:**
- `createPairingCode(userId: number, expiresAt: Date): Promise<{ id: string; code: string; expiresAt: Date }>` stores only a hash of the code.
- `exchangePairingCode(code: string): Promise<{ deviceId: string; credential: string } | null>` is atomic and single-use.
- `listDevices(userId: number)`, `revokeDevice(userId: number, deviceId: string)`, and `getDeviceByCredentialHash(hash: string)` enforce ownership in SQL predicates.
- `appendCommand(userId: number, deviceId: string, command: NewCommand)` and `readPendingCommands(deviceId: string)` are idempotent.
- `recordHeartbeat(deviceId: string, heartbeat: SanitizedHeartbeat)`, `readDashboardState(userId: number)`, and `appendEngineEvents(deviceId: string, events: SanitizedEvent[])` reject data outside the schema.

- [ ] **Step 1: Write migration and repository contract tests.** Test unique Telegram account/device relationships, one-time pairing, revoked credential denial, command uniqueness, bounded event size, and user predicates.
- [ ] **Step 2: Run the PostgreSQL test in the configured CI service.** Run `npm run test:engine-store`; expect RED until migration and repository code exist. Do not substitute SQLite for concurrency tests.
- [ ] **Step 3: Implement the migration.** Add tables for `engine_devices`, `engine_pairing_codes`, `engine_commands`, `engine_heartbeats`, `engine_states`, and `engine_events`; add foreign keys, unique hashes, expiry columns, enum/check constraints, and indexes by `user_id`, `device_id`, and freshness.
- [ ] **Step 4: Implement atomic store methods.** Use parameterized SQL and transactions for code exchange, revoke, command insert, and event/state updates; hash credentials with a server-side pepper from an environment secret.
- [ ] **Step 5: Run tests and migration checks.** Run migration up/down in an ephemeral PostgreSQL instance, then `npm run test:engine-store`.
- [ ] **Step 6: Commit.** `git add migrations src/engine-store.ts test/engine-store.ts src/db-pg.ts && git commit -m "feat: add account-scoped engine control storage"`.

### Task 4: Build pairing, request authentication, and control-plane endpoints

**Files:**
- Create: `engine/src/authenticated-client.ts`
- Create: `engine/src/pairing.ts`
- Create: `src/engine-auth.ts`
- Create: `test/engine-api.ts`
- Modify: `src/server.ts`

**Interfaces:**
- `signEngineRequest(credential: string, method: string, path: string, body: string, timestampMs: number, nonce: string): RequestHeaders`.
- `verifyEngineRequest(headers: Headers, method: string, path: string, body: string): VerifiedDevice | null`.
- `POST /api/engine/pairing` accepts verified Telegram `initData` and returns a one-time code.
- `POST /api/engine/pairing/exchange` accepts only `{ code }` and returns a credential once.
- `POST /api/engine/heartbeat`, `POST /api/engine/events`, and `GET /api/engine/commands` use device authentication.
- `POST /api/engine/commands`, `GET /api/engine/dashboard`, `GET /api/engine/devices`, and `POST /api/engine/devices/:id/revoke` use verified Telegram identity.

- [ ] **Step 1: Write API RED tests.** Cover missing/forged Telegram data, expired pairing, code replay, wrong account, missing signature, bad body hash, timestamp skew, nonce replay, revoked device, command idempotency, and cross-account reads.
- [ ] **Step 2: Run the tests to confirm RED.** Run `npm run test:engine-api`; expect route/auth failures.
- [ ] **Step 3: Implement shared request authentication.** Use HMAC over method, path, timestamp, nonce, and exact body bytes; enforce a bounded clock skew and a persistent nonce uniqueness window; compare hashes with constant-time equality.
- [ ] **Step 4: Implement pairing and routes.** Verify Telegram identity before all account operations; return generic errors; never return credential hashes, raw pairing codes after exchange, secrets, or another account’s state.
- [ ] **Step 5: Run API tests and the existing backend suite.** Run `npm run test:engine-api && npm test`.
- [ ] **Step 6: Commit.** `git add engine/src/authenticated-client.ts engine/src/pairing.ts src/engine-auth.ts src/server.ts test/engine-api.ts && git commit -m "feat: pair engines and authenticate control requests"`.

### Task 5: Implement real RPC reads and the local paper engine

**Files:**
- Create: `engine/src/rpc.ts`
- Create: `engine/src/strategy.ts`
- Create: `engine/src/paper.ts`
- Create: `engine/src/safety.ts`
- Create: `engine/src/engine.ts`
- Create: `engine/src/rpc.test.ts`
- Create: `engine/src/paper.test.ts`
- Create: `engine/src/safety.test.ts`

**Interfaces:**
- `SolanaRpc.readIdentity(): Promise<{ network: Network; slot: bigint }>`.
- `SolanaRpc.readPublicBalance(address: string): Promise<{ address: string; lamports: bigint; slot: bigint }>`.
- `validateStrategy(input: unknown, licenceLimits: LicenceLimits): StrategyConfig`.
- `PaperEngine.start(): Promise<void>`, `stop(reason: StopReason): Promise<void>`, `applyCommand(command: EngineCommand): Promise<CommandResult>`, `tick(opportunity: Opportunity): PaperEvent[]`, and `snapshot(): EngineState`.
- `SafetyLatch.trip(reason: StopReason): void` and `SafetyLatch.isTripped(): boolean`.

- [ ] **Step 1: Write RPC tests with a fake JSON-RPC transport.** Verify endpoint TLS URL validation, identity parsing, public-address validation, lamport precision, timeout behavior, and sanitized errors.
- [ ] **Step 2: Write paper/safety RED tests.** Verify stopped startup, strategy bound rejection, deterministic paper fills, position/PnL transitions, STOP precedence, licence expiry stop, and no transaction/signing calls.
- [ ] **Step 3: Implement RPC adapter.** Use `fetch` with a bounded timeout, JSON-RPC request IDs, `getGenesisHash`/configured network mapping, `getBalance`, and no signing-related dependency or method.
- [ ] **Step 4: Implement strategy validation and paper state.** Use integer lamports internally, immutable event records, explicit paper labels, bounded position count, and deterministic fixtures for tests.
- [ ] **Step 5: Implement engine lifecycle and STOP latch.** Start stopped; require valid licence and RPC read before `start_paper`; make `stop` idempotent and dominant; stop on stale control, RPC failure, invalid command, or licence expiry.
- [ ] **Step 6: Run focused tests and static signing scan.** Run `npm run test:engine-rpc`, `npm run test:engine-paper`, and a scan that fails if engine source imports signing/broadcast APIs or contains transaction submission methods.
- [ ] **Step 7: Commit.** `git add engine/src && git commit -m "feat: add real RPC reads and fail-closed paper engine"`.

### Task 6: Connect the engine outbound client and command loop

**Files:**
- Modify: `engine/src/authenticated-client.ts`
- Create: `engine/src/control-loop.ts`
- Create: `engine/src/cli.ts`
- Create: `engine/src/control-loop.test.ts`
- Modify: `engine/package.json`

**Interfaces:**
- `ControlLoop.run(signal: AbortSignal): Promise<void>` sends heartbeat/state, retrieves commands, acknowledges command IDs, and backs off on transient failures.
- `createEngine(options: EngineOptions): Engine` wires config, licence, RPC, safety, paper, and control loop without creating an inbound listener.
- CLI commands are `aria-engine pair`, `aria-engine doctor`, `aria-engine start-paper`, and `aria-engine stop`; all output is redacted.

- [ ] **Step 1: Write loop tests.** Use fake transport and clock to verify signed requests, nonce uniqueness, command acknowledgement exactly once, exponential backoff, stale-control stop, and clean abort.
- [ ] **Step 2: Implement outbound-only loop.** Poll commands over HTTPS, post sanitized state/events, refresh heartbeat, and stop after the defined control grace period; never bind a local port.
- [ ] **Step 3: Implement CLI diagnostics.** `doctor` reports only connectivity, network, public address, balance, licence status, and engine version; it must not print env values or file contents.
- [ ] **Step 4: Run engine tests and inspect listening sockets.** Run `npm run test:engine-loop`; start the CLI in a fixture and assert no server/listener is created.
- [ ] **Step 5: Commit.** `git add engine && git commit -m "feat: add outbound engine control loop and CLI"`.

### Task 7: Add the Telegram Control Center views

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `test/frontend-reality.ts`

**Interfaces:**
- Frontend API helpers call `/api/engine/pairing`, `/api/engine/dashboard`, `/api/engine/devices`, `/api/engine/commands`, and revoke endpoints with Telegram `initData` only where required.
- `renderEngineDashboard(state)` must render disconnected, connected-paper, stopped, expired, and revoked-device states.
- `renderEngineEvent(event)` must use text nodes, not HTML interpolation.

- [ ] **Step 1: Extend the actual shipped-JS VM test.** Assert setup/pairing controls, persistent `PAPER — NO REAL ORDERS`, no generated events, stale-state clearing, STOP rendering, and cross-account error rendering.
- [ ] **Step 2: Run the test to confirm RED.** Run `npm run test:frontend`; expect missing DOM/API behavior.
- [ ] **Step 3: Replace demo sections with real views.** Add setup, controls, operations, activity, and positions panels while preserving FREE-1A fail-closed initial markup and licence flow.
- [ ] **Step 4: Implement dashboard polling and command actions.** Use bounded fetches, abort on timeout, render only server state, disable controls while disconnected/stopped/expired, and show command acknowledgement/rejection.
- [ ] **Step 5: Run the actual shipped-JS test.** Run `npm run test:frontend`; inspect generated HTML for hard-coded live claims and secret-bearing fields.
- [ ] **Step 6: Commit.** `git add public test/frontend-reality.ts && git commit -m "feat: add Telegram paper control center"`.

### Task 8: Add commercial onboarding and operator documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `docs/REAL1_OPERATOR_RUNBOOK.md`
- Create: `docs/REAL1_CUSTOMER_SETUP.md`
- Modify: `railway.json` only for non-secret health/readiness configuration

- [ ] **Step 1: Write documentation acceptance checks.** Check that the docs contain install, pair, doctor, start-paper, stop, revoke, expiry, troubleshooting, and no-live/secret policy instructions.
- [ ] **Step 2: Document the customer journey.** Include exact commands for supported Node versions, local config creation, pairing, paper start, browser/Telegram verification, and safe cleanup.
- [ ] **Step 3: Document operations.** Include Railway variables without values, PostgreSQL migration order, heartbeat freshness, device revocation, incident STOP, and log-redaction policy.
- [ ] **Step 4: Run a documentation link and command check.** Verify every command exists in `engine/package.json`, every endpoint matches the server routes, and no secret example contains a real credential.
- [ ] **Step 5: Commit.** `git add README.md .env.example docs/REAL1_OPERATOR_RUNBOOK.md docs/REAL1_CUSTOMER_SETUP.md railway.json && git commit -m "docs: publish REAL-1 setup and operations"`.

### Task 9: Prove end-to-end paper operation and CI gates

**Files:**
- Create: `test/real1-smoke.ts`
- Create: `scripts/scan-real1-secrets.ts`
- Modify: `.github/workflows/*.yml`
- Modify: root `package.json`

**Interfaces:**
- `test/real1-smoke.ts` runs a local control plane plus engine fixture, pairing, real configured Solana RPC read, paper start, event upload, STOP, and stopped assertion.
- `scripts/scan-real1-secrets.ts` exits non-zero for private-key blocks, secret assignments, signing imports, or live execution code in REAL-1 files; it never prints matched secret values.

- [ ] **Step 1: Write the smoke test harness.** Define environment requirements, skip behavior for unavailable RPC only in local development, and a CI mode that requires the configured devnet endpoint.
- [ ] **Step 2: Run the smoke test to expose missing wiring.** Run `npm run test:real1-smoke`; record each failed stage explicitly.
- [ ] **Step 3: Wire the complete fixture.** Start the Hono app in-process, create a verified Telegram identity, pair a fixture engine, read RPC identity/balance, run paper mode, send one sanitized event, issue STOP, and assert no transaction signature exists.
- [ ] **Step 4: Add CI commands.** Run root typecheck, engine typecheck, all unit/API/frontend tests, PostgreSQL migration tests, REAL-1 smoke test, and secret/signing scan on every PR.
- [ ] **Step 5: Run the full local verification command.** Run `npm ci`, `npm run typecheck`, `npm run typecheck:engine`, `npm test`, `npm run test:real1-smoke`, and `npm run scan:real1`.
- [ ] **Step 6: Commit.** `git add test scripts .github package.json && git commit -m "test: gate REAL-1 with end-to-end paper evidence"`.

### Task 10: Release review and controlled deployment

**Files:**
- No application files unless a release-blocking defect is found.
- Evidence: PR review checklist, CI run, Railway deployment record, HTTP responses, Telegram-context capture.

- [ ] **Step 1: Review the complete diff.** Check account isolation, credential hashing, replay protection, secret hygiene, no inbound engine listener, no signing/broadcast code, and persistent paper disclosures.
- [ ] **Step 2: Verify the exact PR SHA in CI.** Confirm checkout SHA, dependency install, typecheck, all tests, PostgreSQL migration tests, smoke test, and scan are green.
- [ ] **Step 3: Obtain explicit merge authorization.** Do not merge on CI success alone.
- [ ] **Step 4: Capture the merge SHA and verify Railway deployment matches it.** Reject a deployment whose source SHA differs from the merge SHA.
- [ ] **Step 5: Run production checks.** Verify `/healthz`, account/pairing API error behavior without Telegram auth, `/api/product-reality`, disconnected UI, paired paper UI, STOP state, and Telegram-context rendering.
- [ ] **Step 6: Declare REAL-1 only if every gate is evidenced.** The certification is `COMMERCIAL PAPER BETA READY`; it is not live-trading or financial-custody certification.

## Self-review checklist

- Spec coverage: architecture, constraints, data flow, state machines, safety bounds, failure handling, frontend, operations, and release evidence each map to one or more tasks above.
- Placeholder scan: the plan contains no unresolved placeholders or unspecified error-handling instruction.
- Interface consistency: `EngineCommand`, `EngineState`, `StrategyConfig`, `SanitizedHeartbeat`, and `PaperEvent` are defined in Task 1 and consumed consistently by Tasks 3–9.
- Scope check: live execution, custody, deposits, withdrawals, and transaction signing are explicitly excluded and require REAL-2.
