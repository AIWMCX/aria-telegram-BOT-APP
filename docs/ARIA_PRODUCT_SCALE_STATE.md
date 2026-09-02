# ARIA product + scale state

Durable memory file per the product/scale master prompt. Read this
before re-deriving product/scale priorities from scratch.

**Read this file's own discipline before adding to it**: the source
prompt's own §41/§47 say not to build scale infrastructure before
measurements justify it, and never to certify a scale stage without
load evidence. As of this entry, ARIA has not shipped to a single real
external user yet — every "scale" section below is honestly marked
`NOT_APPLICABLE (0 users)`, not `MISSING`, because building it now
would itself violate this document's own rule.

## CURRENT DATE

2026-09-02 (updated same day, post-real-acceptance-test).

## CURRENT SHAS

- `aria-engine` main: `010ffb9e5a56cb1fe524e665190c4efa7bfb633b`
- `aria-telegram-BOT-APP` main: `db3e2df80fbeb2e0d180e29cc717380358f31e87`
- Both pushed and deployed 2026-09-02: GitHub CI green on `aria-engine`;
  Railway deployment `5d9dd4cc` status SUCCESS for `aria-telegram-BOT-APP`
  (project `bubbly-prosperity`, service `aria-telegram-BOT-APP`).
- Published release: `aria-engine-0.7.0-beta.4.tgz`, sha256
  `ecaa009307c83ce846e6d181f2dcf1f5ada9ed6ef64cdcf95f0f578d43140619`, live
  at `https://aria-telegram-bot-app-production.up.railway.app/downloads/latest.json`
  — verified by downloading the production file directly and re-hashing it
  (matched exactly), not just trusting the deploy succeeded.

## CURRENT USERS / ACTIVE ENGINES

**One real user, fully verified end-to-end, same day.** A real Telegram
user generated a real single-use pairing code, ran `aria pair`, `aria
doctor`, `aria paper start`, and `aria journal` against the real published
`0.7.0-beta.3` build on their own machine. Real evidence, not assumption:
  - `aria journal` after real synthetic trading: `DETECTED 41, TRADED 3,
    REJECTED 38, OPEN 1, CLOSED 2, WINS 2, LOSSES 0, REALIZED PNL 8418210
    lamports`.
  - **Restart-recovery gate passed**: `aria paper stop` → `aria paper
    start` → `aria journal` showed the exact same `OPEN 1 / CLOSED 2 /
    WINS 2 / PNL 8418210` after restart, with `DETECTED`/`REJECTED`
    climbing further from new post-restart activity (41→50, 38→47) — state
    genuinely persisted across a process restart, not reset.
  - The full install→doctor→pair→PAPER-start→journal→replay→stop→restart
    flow is now closed with real evidence, not just code-level readiness.

## RELEASE VERSION

`0.7.0-beta.4`, deployed and verified live in production 2026-09-02.

Release label: **`PAPER_READY`, not `CLOSED_BETA_READY` yet.** Two gates
from the same acceptance test, tracked separately — do not conflate them:

```
RESTART RECOVERY
PASS

Evidence:
paper stop -> paper start retained:
  OPEN 1
  CLOSED 2
  WINS 2
  LOSSES 0
  REALIZED PNL 8,418,210 lamports

Post-restart discovery continued:
  DETECTED 41 -> 50
  REJECTED 38 -> 47

SYNC (engine <-> control plane)
INVESTIGATING
ROOT CAUSE: NOT YET PROVEN

Observed:
  server rejected every sequence-advance attempt for one real device
  across a live acceptance test (~40+ consecutive 409s, 01:58-02:18).

Ruled out by static inspection:
  - nullable/default-zero schema issue (last_sequence is bigint NOT NULL
    default 0)
  - silent duplicate-device UPSERT (registerClient does a plain INSERT;
    a reused device_public_key throws a unique-constraint 409 from
    /api/engine/pair, not a silent row reuse)
  - pairing state saved on a failed pair (pairing-client.ts only calls
    savePairingState after a successful response)
  - same-process doSync overlap (cli.ts's sync loop is fully sequential
    -- each doSync is awaited before the next runs; nextSequence() has no
    internal await, so two calls in one process cannot interleave)

Mitigation deployed (0.7.0-beta.4), NOT a fix:
  server returns currentSequence on a 409; client adopts it and retries
  once. Does not appear to weaken replay defense (the retry requires a
  fresh signature from the device's real private key, and
  currentSequence comes only from the server's own stored counter, never
  client input) -- but this masks the symptom, it does not explain the
  divergence, and that claim itself is unverified until proven.

Required before closing:
  reproduce cases A-D (this repo's `src/engine-sync-desync-repro.ts`,
  guarded by RUN_SYNC_DESYNC_REPRO; case B needs a real client restart —
  see the "sync diag" log lines in aria-engine's cli.ts and this repo's
  server.ts) and
  capture, at the FIRST rejection, the exact pair of values: local
  pairing-state.json lastSequence (pre-increment) vs production
  engine_clients.last_sequence for the same clientId. Until that pair is
  captured, root cause is speculation.
```

Mini App mobile/desktop visual check is still open (the user's own
screenshots show it rendering correctly on Telegram desktop; a mobile
check hasn't been explicitly done).

## TOP USER FRICTION (found this session, real, not hypothetical)

1. `/support` linked to `PUBLIC_URL + "/docs"` — a route that has never
   existed. Every tap 404'd. **Fixed** (`bfc519d`) — now points at the
   real Terms/Privacy/Risk-Disclosure/Refund/Support section on the
   Mini App page itself.
2. No `/help` command existed at all. **Fixed** (`bfc519d`).
3. Public mainnet RPC (no dedicated provider configured) causes visible,
   real, recurring `HTTP 429`s under any concurrent load — confirmed
   directly during both the real-mainnet soak and repeated `aria doctor`
   runs. Self-recovers within one retry every time observed so far, but
   this is a real, disclosed reliability ceiling until a dedicated RPC
   is configured (`BLOCKED_EXTERNAL`, no credentials available).
4. Real, found during the first real user's live acceptance test: the
   control plane's replay-defense sequence counter desynced between a
   device's local state and the server's stored counter, and once
   desynced, cloud sync (`snapshot`/`event_batch`) was rejected forever
   with no recovery path — silently starving the Mini App of state while
   local PAPER trading kept working fine underneath (local journal writes
   never depended on sync succeeding). **A mitigation is deployed**: the
   409 now returns the server's authoritative `currentSequence`
   (`aria-telegram-BOT-APP` `84ad2d4`), and the client self-heals by
   adopting it and retrying once (`aria-engine` `75f0750`, shipped in
   `0.7.0-beta.4`). **The root cause is NOT yet proven** — static code
   review ruled out several obvious explanations (see SYNC below) but did
   not identify the actual divergence mechanism. Do not treat this as
   closed; the mitigation is deployed as a safety net while the real
   cause is instrumented and reproduced.

## CURRENT INCIDENTS

None active. One real, severe one was found and fully fixed+verified this
session:
- `PollingRpcTransport` was awaiting `getTransaction` sequentially with no
  concurrency cap, causing single polls to stall 15–64 minutes under real
  backlog. Fixed in `aria-engine` PR #7, merged as `62cd09b`, verified via
  a real wall-clock test and a second live soak showing zero recurrence.

One is still open, investigation in progress (see SYNC below):
- Cloud-sync sequence desync — mitigation deployed, root cause unproven.

## CURRENT P0

Finishing `CLOSED_BETA_READY` for the PAPER beta — see
`aria-engine/docs/REAL2_EXECUTION_STATE.md` for the exact remaining
gates. In order: real-mainnet soak completion evidence, real Telegram
pairing test (needs a human), Mini App mobile/desktop visual check
(needs a human), then the release-freeze record closes out.

## 1K / 5K / 10K / 30K STATUS

All four: **NOT_APPLICABLE (0 users)** — per this document's own §41/§47,
building rate limiting, notification queues, DB scale audits, or load
tests for a product with zero production traffic would be premature
complexity, not readiness work. Revisit each stage only once real usage
data exists to measure against. Nothing here should be read as "missing
infrastructure" — it's correctly deferred, not overlooked.

## SLO STATUS

Not yet measured — no production traffic to measure against. The one
real, already-measured latency data point: `PollingRpcTransport`'s real-
mainnet tick timing (p50 ~7s, p95 ~10s, zero multi-minute stalls) from
the post-fix soak — this is discovery-layer latency, not an API/Mini-App
SLO, and should not be conflated with either.

## KNOWN SCALE LIMITS

- SQLite (via `node:sqlite`) backs the control plane — fine at current
  (zero) load; whether it needs to change is a question for when real
  concurrent-write evidence exists, not before.
- No dedicated/paid Solana RPC configured — real, current reliability
  ceiling for ANY user count, not just at scale.
- No notification queue, no background-job separation, no rate limiting
  exist yet — correctly absent at 0 users per this doc's own discipline,
  not silently missing.

## BLOCKED_EXTERNAL

- Dedicated Solana RPC + fallback — needs a real paid provider credential.
- `$rypto$` / AIWMC entity separation — needs a business/legal decision
  before accepting paid subscriptions (per `aria-telegram-BOT-APP`'s own
  CLAUDE.md).
- Real Telegram pairing-code generation and Mini App mobile/desktop
  visual check — need a human on a real Telegram client.

## NEXT TASK

Restart-recovery gate: closed, real evidence, PASS. Sync gate:
INVESTIGATING — do not announce beyond the current single real user until
this closes. In order:
1. **Done**: instrumented both boundaries (client `doSync` in
   aria-engine's `cli.ts`, server `/api/engine/sync` in this repo's
   `server.ts`) with a safe diagnostic tuple — no secrets, signatures, or
   key material — on every sync attempt. Also **done**: a real-Postgres,
   real-HTTP reproduction harness (`src/engine-sync-desync-repro.ts`,
   `RUN_SYNC_DESYNC_REPRO`) covering cases A/C/D.
2. Reproduce cases A (fresh identity+pair), B (same identity, normal
   restart), C (re-pair with an existing identity), D (process killed
   after local persist, before HTTP response) and capture the local-vs-
   server sequence pair at the first rejection for each.
3. Root-cause the actual divergence from that evidence, then decide the
   real fix — an explicit authenticated resync path tied to device
   identity if recovery semantics are genuinely needed, not just today's
   silent-adopt mitigation left in place indefinitely.
4. Write the required regression tests (fresh/monotonic/skipped/
   duplicate/lower sequence, restart, failed-network-request replay
   safety, re-pair behavior, same-identity-two-processes).
5. Full suite, typecheck, CI, then a real production sync succeeding
   repeatedly after restart — that's what actually closes this, not the
   mitigation shipping.
6. Mini App mobile visual check (desktop confirmed via real screenshots).
7. THEN: announcement/distribution — still gated on the same demand
   trigger this document has said all along (§41/§47): there is exactly
   one real user right now, so "growth work" still means "get the next
   handful of real users," not scale infrastructure.
