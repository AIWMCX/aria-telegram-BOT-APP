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

2026-09-02.

## CURRENT SHAS

- `aria-engine` main: `6ac72d5863c90c94435e3ebb02b63eb94ff7b958`
- `aria-telegram-BOT-APP` main: `bfc519d...` (fix(bot): /support 404 + /help)
- Published release: `aria-engine-0.7.0-beta.3.tgz`, sha256
  `2c1ae0592cf01bd360b94316e7b95702064d1f5d4f18563a2a9acacd5aefe28b`,
  live at `public/downloads/latest.json`, confirmed served in production.

## CURRENT USERS / ACTIVE ENGINES

**Zero.** No real external Telegram user has completed onboarding yet.
The full install→doctor→pair→PAPER-start→journal→replay→stop→restart
flow has been verified up to the pairing step (which needs a real
human on Telegram to generate a code) — see GAP_MATRIX.md /
REAL2_EXECUTION_STATE.md in `aria-engine` for the engine-side evidence.

## RELEASE VERSION

`0.7.0-beta.3`. Release label: `PAPER_READY` (not yet `CLOSED_BETA_READY`
— real Telegram pairing and Mini App mobile/desktop visual check are
still open, both needing a human, not more code).

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

## CURRENT INCIDENTS

None active. (A real, severe one was found and fixed this session:
`PollingRpcTransport` was awaiting `getTransaction` sequentially with no
concurrency cap, causing single polls to stall 15–64 minutes under real
backlog. Fixed in `aria-engine` PR #7, merged as `62cd09b`, verified via
a real wall-clock test and a second live soak showing zero recurrence.)

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

Continue the in-flight PAPER beta certification (soak checkpoints,
pairing, Mini App check) rather than starting scale/analytics/growth
work this document also describes — that work has a real, correct
trigger condition (measured user demand) that hasn't occurred yet.
