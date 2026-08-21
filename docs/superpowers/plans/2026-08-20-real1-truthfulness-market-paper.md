# REAL-1 Truthfulness and Market-Paper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unsupported customer claims from REAL-1 and add a read-only, fail-closed mainnet market observation path that can drive paper-only state.

**Architecture:** The control plane remains the owner of Telegram identity and cloud snapshots. The local engine receives read-only quote data, normalizes it into `MarketObservation`, rejects stale or divergent sources, and permits only paper events/state. No wallet material or transaction primitives are added.

**Tech Stack:** TypeScript, Node 22, Zod, Hono, Grammy, PostgreSQL control-plane protocol.

**Spec:** User-provided `ARIA REAL-1 — Truthfulness Fix + Real-Market Paper Session` production execution prompt (2026-08-20).

## Global Constraints

- No private keys, keypairs, signing, transaction construction, broadcast, swap execution, Jito, custody, `live` execution mode, or real orders.
- REAL-1 customer copy must say mainnet market data + paper execution + no real orders/no custody.
- Tests run RED → GREEN before each behavior change.
- Production release only after exact-SHA CI, genuine Railway checks, and real Telegram-authenticated E2E evidence.

---

### Task 1: Permanent commercial truthfulness gate

**Files:**
- Create: `test/real1-truthfulness.ts`
- Modify: `src/config.ts`, `src/bot.ts`, `package.json`

- [ ] Write a source-level failing test that reads `src/config.ts`, `src/bot.ts`, and `public/index.html`.
- [ ] Assert all issuable `TIER_LIMITS` feature arrays omit `live` and `jito_bundles`; assert `/start` uses `ARIA REAL-1 Terminal`, `Paper execution`, `No real orders`, and `No custody`.
- [ ] Run `npx tsx test/real1-truthfulness.ts`; confirm RED against the current `live` entitlement and “live terminal” copy.
- [ ] Restrict each currently issuable tier to paper-compatible features and replace `/start` copy.
- [ ] Add the test to `npm test`; rerun it GREEN.
- [ ] Commit focused truthfulness changes.

### Task 2: Read-only mainnet quote boundary

**Files:**
- Create: `engine/src/market-sources.ts`, `engine/src/market-sources.test.ts`
- Modify: `engine/package.json`

- [ ] Write failing tests for a read-only quote adapter: validates a mainnet token mint, rejects malformed/non-positive prices, records source/received time/latency, and rejects a source disagreement above the configured limit.
- [ ] Run the engine test and confirm RED because no quote adapter or agreement gate exists.
- [ ] Implement only HTTPS `GET` market-data adapters and pure normalization/agreement functions. The adapter interface must expose no signing, POST swap, or transaction API.
- [ ] Rerun targeted tests GREEN and engine typecheck.
- [ ] Commit the bounded read-only market source implementation.

### Task 3: Market observation to paper candidate bridge

**Files:**
- Create: `engine/src/market-paper-session.ts`, `engine/src/market-paper-session.test.ts`
- Modify: `engine/src/engine.ts`, `engine/src/contracts.ts`, `engine/package.json`

- [ ] Write failing tests proving fresh, agreed observations create a paper-only candidate; stale/disagreed observations only produce a rejected paper event and cannot create a position.
- [ ] Run targeted test RED.
- [ ] Implement a narrow `MarketPaperSession` that maps validated observations to existing `Engine.tick()` opportunities; serialize source, mint, price, observation timestamp, and risk decision into paper event data.
- [ ] Keep all execution types restricted to `paper`; rerun GREEN plus all engine tests.
- [ ] Commit the bridge.

### Task 4: Snapshot/event protocol contract hardening

**Files:**
- Modify: `src/server.ts`, `src/engine-snapshots.ts`, `src/engine-events.ts`, `test/engine-customer-api-contract.ts`, `test/e2e.ts`

- [ ] Write failing protocol tests for a paper snapshot containing required counters and for replayed event batches producing no duplicate logical event.
- [ ] Run RED against current opaque snapshot/event acceptance.
- [ ] Validate the paper snapshot schema server-side while preserving user/device ownership; store only idempotent events.
- [ ] Run targeted tests GREEN and preserve STOP authorization.
- [ ] Commit protocol hardening.

### Task 5: Local real-market evidence and release verification

**Files:**
- Create: `docs/verification/real1-market-paper-session-<date>.md`

- [ ] Run `aria doctor` against a configured read-only mainnet endpoint; record genesis identity and slot.
- [ ] Run one real, current market quote through the local paper session; record mint, source quotes, age, deviation, decision, and generated paper state. Do not fabricate a quote or force a close.
- [ ] Pair a real engine and verify `ENGINE == CLOUD == TELEGRAM` with authenticated Telegram initData; test PAUSE, STOP, and `request_snapshot`.
- [ ] Run `npm run typecheck`, `npm test`, engine typecheck/test, `git diff --check`, and the HARD STOP source/dependency scan.
- [ ] Create a PR; require exact-SHA CI, Railway exact deploy SHA, `/healthz`, logs, and Telegram Mini App evidence before merge.
