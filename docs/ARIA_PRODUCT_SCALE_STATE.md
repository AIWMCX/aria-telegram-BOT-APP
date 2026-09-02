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

- `aria-engine` main: `6ac72d5863c90c94435e3ebb02b63eb94ff7b958`
- `aria-telegram-BOT-APP` main: `bfc519d...` (fix(bot): /support 404 + /help)
- Published release: `aria-engine-0.7.0-beta.3.tgz`, sha256
  `2c1ae0592cf01bd360b94316e7b95702064d1f5d4f18563a2a9acacd5aefe28b`,
  live at `public/downloads/latest.json`, confirmed served in production.

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

`0.7.0-beta.3`. Release label: `CLOSED_BETA_READY` as of this entry — the
fresh-user pairing/onboarding/restart-recovery gate that was the last
open item is now closed with real evidence (see above). Mini App
mobile/desktop visual check is still open (the user's own screenshots
show it rendering correctly on Telegram desktop; a mobile check hasn't
been explicitly done).

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
   control plane's replay-defense sequence counter could desync between
   a device's local state and the server's stored counter (exact trigger
   not fully pinned — restart timing is the leading hypothesis), and once
   desynced, cloud sync (`snapshot`/`event_batch`) was rejected forever
   with no recovery path, silently starving the Mini App of state while
   local PAPER trading kept working fine underneath (local journal writes
   never depended on sync succeeding). **Fixed same day**: the 409 now
   returns the server's authoritative `currentSequence`
   (`aria-telegram-BOT-APP` commit `84ad2d4`), and the client self-heals
   by adopting it and retrying once (`aria-engine` commit `75f0750`).
   Not yet re-verified against a live desynced device — the original
   desync was resolved by a stop/restart before this fix was written, so
   the self-heal path itself has unit/typecheck coverage but no real-world
   confirmation yet.

## CURRENT INCIDENTS

None active. Two real, severe ones were found and fixed this session:
- `PollingRpcTransport` was awaiting `getTransaction` sequentially with no
  concurrency cap, causing single polls to stall 15–64 minutes under real
  backlog. Fixed in `aria-engine` PR #7, merged as `62cd09b`, verified via
  a real wall-clock test and a second live soak showing zero recurrence.
- Cloud-sync sequence desync (see friction item 4 above) — fixed, not yet
  re-verified live.

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

Fresh-user PAPER beta certification is now closed with real evidence.
`0.7.0-beta.4` is built, verified (clean-checkout npm ci/typecheck/full
suite/guardrail/CLI smoke test), and published to
`public/downloads/latest.json` — carries the sync self-heal fix. Remaining
before wider announcement:
1. **Push these commits to GitHub and deploy the control plane** — all of
   today's fix/release commits (`aria-engine` up to `010ffb9`,
   `aria-telegram-BOT-APP` up to `a09da97`) exist locally only as of this
   entry; nothing has been pushed. This is the actual remaining blocker —
   until deployed, the live server still runs the pre-fix code, so a real
   desynced device would still need a manual re-pair, not the self-heal
   path (the LOCAL journal/PAPER-trading path is unaffected either way).
2. Re-verify the self-heal fix against a real live desync once deployed —
   it has unit/typecheck coverage and a clean install/CLI smoke test, but
   no real-world confirmation yet.
3. Mini App mobile visual check (desktop confirmed via real screenshots).
4. THEN: announcement/distribution — still gated on the same demand
   trigger this document has said all along (§41/§47): there is exactly
   one real user right now, so "growth work" still means "get the next
   handful of real users," not scale infrastructure.
