# ARIA product + scale state

Durable memory file per the product/scale master prompt. Read this
before re-deriving product/scale priorities from scratch.

**Starting a new session on 2026-09-03 or later? Read
[`SESSION_HANDOFF_2026-09-02.md`](./SESSION_HANDOFF_2026-09-02.md) next —
it has the exact P0-1 through P0-9 execution order for the sync-desync
investigation and beta acceptance. Don't reconstruct the plan from chat
history.**

## SESSION B, ITEM 1 OF 8 — FUNNEL TELEMETRY + BETA OPS VIEW SHIPPED (2026-09-06T18:41 UTC)

Commit `5a3a08a`, deployment `597e781a`, verified live via `/healthz`
(`{"ok":true,"uptime":298.5,"leads":3,"paymentsEnabled":false}`) after
`list-deployments` confirmed `SUCCESS` — the prior deployment briefly
showed `CRASHED` during cutover, the same harmless transient artifact
observed and confirmed false-alarm many times this session; it settled
to `REMOVED` once the new one reached `SUCCESS`.

- New `funnel_events` table (append-only: event name, optional user_id,
  optional jsonb metadata) — `src/funnel.ts`'s `trackEvent()` never
  throws, so a telemetry write failing can never break the real action
  it's recording.
- Wired into real existing action points, not new instrumentation-only
  paths: `invite_created`, `invite_redeemed` (`invites.ts`),
  `pairing_code_created` (`server.ts`), `pairing_completed`
  (`invites.ts`'s `markInvitePaired`, guarded to fire only on the
  actual activated→paired transition), `miniapp_opened`
  (`/api/product-reality`, called once per page load — not the
  `/api/engine/me` endpoint the Mini App polls every 5s), `support_opened`
  (`/support` command).
- Deliberately NOT tracked, and why: `journal_opened` (aria-engine's
  `journal` command is local-only CLI, never reaches the control plane
  — no event exists to hook); `engine_online`, `first_candidate_seen`,
  `first_position_seen` (correctly detecting "first" needs new per-user
  state or an expensive existence check every sync tick, and the PAPER
  snapshot already surfaces open/closed/rejected counts in the Mini App
  — revisit only if the simpler events show it's actually needed).
- New `/beta` admin bot command: cohort counts (invited/activated/paired)
  + all-time funnel counts + per-user status list — built on data now
  being written, not a new dashboard surface.

Typecheck clean, full suite green (`frontend-reality.ts` unaffected —
`/api/product-reality`'s response shape is unchanged).

**Session B, item 2/8 — invite attribution (commit `faa0eed`, deployment
`cf890fee`, verified live via `/healthz` fresh-boot uptime):** added
`getAttributionBreakdown()` (`invites.ts`) and `/attribution` admin
command — groups the existing `invites.note` column into
invited/activated/paired counts per source. No new schema; the `note`
field already tagged sources at `/invite <note>` creation time, this
was just the missing cross-cohort rollup query.

**Session B, item 3/8 — feedback capture (commit `43c5686`, deployment
`bc39a8e5`, verified live via `/healthz` fresh-boot uptime of 16.7s
confirming the new migration applied without crashing boot):** new
`feedback` table, `POST /api/feedback` (Telegram-authenticated like
pairing-code issuance, deliberately NOT invite-gated — anyone who
opened the Mini App can leave feedback), a Mini App panel (textarea +
send button), `feedback_submitted` funnel event, and a `/feedback`
admin command reading the last 20 submissions. No thread/status
workflow — read-and-follow-up-directly, same posture as `/beta` and
`/attribution`.

**Session B, item 4/8 — candidate-rejection explanation drawer (commit
`ef66e83`, deployment `28dac91d`, confirmed `SUCCESS` via
`list-deployments`):** the event feed showed rejection events as a
bare type name with no explanation. Checked `aria-engine`'s actual
source (`src/paper/paper-risk.ts`, wired through the real production
path `paper-loop.ts` — not the separate `shadow-loop.ts`) rather than
guessing: every rejection already carries one of exactly 8 real reason
codes (`stale-observation`, `invalid-input`, `invalid-price`,
`duplicate-candidate`, `position-cap`, `daily-loss-limit`,
`mint-cooldown`, `exposure-cap`), already synced end-to-end through
`event_batch` → `engine_events` → `/api/engine/me`'s
`events[].data.reason`. No aria-engine change needed — pure Mini App
surfacing: rejection rows now show a plain-English summary and expand
on click to a fuller explanation. Unmapped future reason codes fall
back to showing the raw code, never silently dropped.

**Session B, items 5+6/8 — LIVE and paid-interest capture (commit
`35e42d1`, deployment `fa668db4`, confirmed `SUCCESS`):** the disabled
REAL-2 and COMMERCIAL GA pricing tiles had fully inert buttons
("NOT AVAILABLE", no handler) — wasted demand signal. New
`POST /api/interest` fires `live_interest_clicked` /
`paid_interest_clicked` (funnel event names that existed in
`funnel.ts`'s union since item 1 but had no caller until now). Buttons
now read "NOTIFY ME WHEN AVAILABLE" / "I'D PAY FOR THIS", disable and
confirm on click. Still make no false claim that either product
exists — pure signal capture, not a waitlist or purchase flow.

**Session B, item 7/8 — notification preferences (commit `fb3f1c3`,
deployment `7c3a7acd`, confirmed `SUCCESS`):** audited what this bot
actually sends unsolicited before building anything — license issuance
and 7d/1d expiry warnings are informational about the user's own
account state (muting expiry warnings and then silently losing access
would make things worse, not better) and stay unconditional; the one
genuinely promotional message is `notifyCustomerLicenseIssued()`'s
$RYPTO$ community join prompt, already flagged in its own comment as a
spam risk. New `notify_promotions` column on `leads` (SQLite,
defensive `ALTER TABLE` per this file's existing pattern), default on.
`/notifications [on|off]` toggles it; the $RYPTO$ DM now checks it.

**Session B, item 8/8 — version/update enforcement (commit `3d2ff3b`,
deployment `1867f1b0`, confirmed `SUCCESS`, fresh-boot `/healthz`
uptime 34.7s):** confirmed aria-engine has no existing update-notice
mechanism (private git checkout, not a registry — checked its README
and CLI directly) before building one. `MIN_SUPPORTED_ENGINE_VERSION`
in `config.ts` (currently `0.7.0-beta.4`, matching aria-engine's real
`ARIA_VERSION` at time of writing — a value to bump by hand on a real
future release, not a moving target) is compared by exact string match
against the paired device's reported version, deliberately not semver
ordering (comparing prerelease tags like `beta.4` numerically would be
more likely wrong than an honest "doesn't match"). `/api/engine/me`
returns `device.versionStatus` (`current`/`outdated`/`unknown` — never
silently calling an old-format device "outdated") and
`minSupportedVersion`; the Mini App shows a plain-language banner with
real instructions (pull latest code, `npm install`, re-pair) when
outdated. Deliberately non-blocking — disclosure, not a hard gate,
since a soft version mismatch shouldn't lock a beta user out of PAPER
trading.

**REGRESSION FOUND AND FIXED (commit `6bbec06`, deployed, confirmed live
by curling production `/app.js` directly — not just re-trusting a
typecheck/test pass):** a leftover `$("btn-standard").disabled = true;
$("btn-pro").disabled = true;` line from before commit `35e42d1`
repurposed those buttons ran AFTER the interest-capture click handlers
were attached, silently defeating items 5+6 (LIVE/paid-interest CTAs)
in production this whole time despite that commit's tests passing and
its message claiming it worked. Neither the test suite nor the earlier
`/healthz` check could have caught this — it's a DOM-interaction bug,
not a server-side or schema issue. Caught by actually loading the page
in a browser and checking `.disabled` at runtime, not by re-reading the
diff. Lesson: a green test suite proves the tested paths, not the whole
page — worth an actual browser check on any UI commit touching
pre-existing init code, not just new code.

**SESSION B COMPLETE — all 8 items shipped** (funnel telemetry, beta
ops view, invite attribution, feedback capture, candidate-rejection
drawer, LIVE-interest CTA, paid-interest CTA, version enforcement).
Every item was individually typechecked, tested, committed, deployed,
and confirmed live via `/healthz` and `list-deployments` before moving
to the next — no batch-and-hope. Combined with Session A (shipped
earlier the same day), the full 20-item productization proposal from
tonight's master prompt is now closed out.

## MINI APP UX — SESSION A SUBSET SHIPPED (2026-09-06T18:19 UTC)

From a 20-item productization proposal, shipped the bounded, low-risk
subset that's pure UI/copy on existing endpoints (commit `5542970`,
verified live in production by downloading the real page and confirming
the new markup is actually served, not just checking the deploy log):

- One-time PAPER-mode explainer panel (localStorage-gated), manually
  verified in-browser to show once and stay dismissed across reload.
- `COPY SUPPORT DIAGNOSTICS` button — safe fields only (version,
  connection, mode, market-data state, last sync, random diagnostic
  ID), verified no secret material is included.
- Reworded disconnected/empty-state copy to be actionable ("Connect
  your ARIA engine — no chat command needed") and honest ("most
  candidates being rejected is normal, not broken").

`test/frontend-reality.ts` and `test/real1-truthfulness.ts` both pass
unmodified — no truthfulness-claim regression from this pass.

**Deliberately NOT done this pass** (real, scoped, still open):
version/update-compatibility enforcement, candidate-rejection
explanation drawer, funnel instrumentation (`invite_created` ->
`onboarding_completed` event chain), feedback capture, notification
preferences, beta operations view, invite attribution, LIVE-interest
and paid-interest capture. These are Session B of the same proposal —
pick up there next, not by re-deriving the list from scratch.

## PIVOT 2026-09-05/06: TELEGRAM COMMAND DEPENDENCY REMOVED FROM CRITICAL PATH

After the 3s webhook reassertion could not be proven (20-command retest
was never run — no human sent it), the plan changed: stop trying to make
Telegram chat delivery perfect, remove it from the critical onboarding
path instead. Verified, not built from scratch:

- `public/app.js`'s `pairEngine()` -> `POST /api/engine/pairing-code`
  has NEVER depended on any bot chat command — it uses Telegram's
  `initData` directly. This is the exact path the real first user
  already used successfully (their screenshot: "Run: aria pair
  Y53-3cDOa5LykGyxjHCfTLn6M7g..." came from this code, not `/pair`).
- Same endpoint already carries the invite gate (`isUserApproved`)
  added earlier this session.
- **Real gap found and fixed while verifying**: `bot.command("pair")`
  called `createPairingCode()` directly, bypassing the invite gate
  entirely — an uninvited user typing `/pair` in chat got a real
  pairing code. Same-severity gap as the original P0-B hole. Fixed
  with the identical `isUserApproved` check (commit `3ddae82`).
- Added a customer-facing fallback notice next to CREATE PAIRING CODE:
  Telegram chat may be delayed, this button works independently — no
  technical 409/getUpdates detail exposed to users.

**TELEGRAM_COMMAND_TRANSPORT remains DEGRADED and UNRESOLVED.** This
pivot does not close P0-A — it means P0-A no longer blocks onboarding.
Root cause of the external interference is still unknown. The 3s
unconditional webhook reassertion is still the live production
configuration; it was never proven or disproven with a real 20-command
test (the last real test was the 15s version: 31% delivery, worse than
polling's 57%). Do not resume tuning the reassertion interval — that
path is explicitly retired per this session's own decision rule, not
because it was tested and failed, but because the fallback made further
tuning unnecessary for launch.

**User #2/#3 acceptance via the Mini App fallback has NOT been run.**
The infrastructure is verified correct by direct code inspection; the
actual "second/third real human completes the flow" test still needs
the project owner to invite two more real people — no agent can
originate that.

**Read this file's own discipline before adding to it**: the source
prompt's own §41/§47 say not to build scale infrastructure before
measurements justify it, and never to certify a scale stage without
load evidence. As of this entry, ARIA has not shipped to a single real
external user yet — every "scale" section below is honestly marked
`NOT_APPLICABLE (0 users)`, not `MISSING`, because building it now
would itself violate this document's own rule.

## P0-B / P0-A STATUS (2026-09-04T03:04 UTC)

```
P0-B INVITE CONTROL:
PASS — admin can create invite records (real, in production: /invite
       created "test user 2" and one unlabeled invite)
PASS — /invites returns persisted records (real reply observed)
PASS — admin identity confirmed (telegramUserId ...7597208041 passed
       isAdmin() with zero "unauthorized" log lines)
PENDING — second-account redemption + pairing acceptance not yet run

P0-A TELEGRAM DELIVERY:
FAIL / INVESTIGATING
Evidence (2026-09-04T02:54-02:56 UTC window):
  /start   -> COMMAND_RECEIVED logged, replied
  /invite  -> COMMAND_RECEIVED logged, admin check passed, replied
  /invites -> COMMAND_RECEIVED logged, replied
  /help    -> sent by admin, ABSENT from application logs entirely
Impact: update delivery is upstream of command handling — not a /help
  bug, not an admin-config bug. Telegram polling conflict (still
  externally caused, still unresolved) is dropping updates, not just
  delaying them. Not reliable enough for user #2 onboarding yet.
```

Diagnostic logging upgraded same session: every update (not just
commands) now logs `TELEGRAM_UPDATE_RECEIVED` with Telegram's own
`update_id` + a per-process `processBootId` (commit `a6f91ab`, deployed,
healthy). This is what the next real test needs — comparing update_id
sequence against what Telegram actually sent, not just counting missing
replies.

**Next action, narrow and evidence-driven — do this before inviting user
#2, not more invite-system work (that's done):**
Send 20 commands at spaced intervals (5x each: `/help`, `/start`,
`/license`, `/invites`) and pull `TELEGRAM_UPDATE_RECEIVED` +
`BOT_POLL_FAILED` from the logs for that exact window. Compute: sent /
received / responded / missed / median latency / max latency / delivery
success %. Done condition: 20/20 observed server-side and responded
correctly, zero `getUpdates` conflict during the window. Only after that
passes: real second-account redemption -> `/pair` -> `DEVICE ONLINE` ->
`/invites` showing `paired` state = **FIRST-10 FREE BETA ONBOARDING:
READY FOR USER #2**.

P0-A (Telegram bot conflict) root cause is UNCHANGED from earlier tonight
— still an external cause outside this session's visibility. Do not invite new users
until that's resolved even though the invite gate itself is ready.

## CURRENT DATE

2026-09-03 (updated same day — TELEGRAM BOT CONFLICT INCIDENT, see below).

## TELEGRAM BOT CONFLICT INCIDENT (2026-09-03)

**Status: MITIGATED, ROOT CAUSE UNRESOLVED.** Do not re-close this without
re-reading it.

Timeline:
1. Discovered while investigating the P0-1 sync repro: production logs
   showed a continuous `409: Conflict: terminated by other getUpdates
   request` cycle — something else was long-polling Telegram with the same
   `TELEGRAM_BOT_TOKEN`.
2. Ruled out, with direct evidence, not assumption: `aria-real1-preview`
   (its startCommand only runs migrations + `server.ts`, confirmed via
   `get-service-config` twice), every other Railway service/project on the
   account (full sweep), this local dev machine (no matching process), and
   GitHub Actions (only workflow is `CI`, tests only, never references
   `TELEGRAM_BOT_TOKEN`).
3. Bot token was rotated via BotFather. The first attempt to save the new
   token in Railway was pasted wrapped in `${{ }}` (Railway's variable-
   reference syntax) — that corrupted the value badly enough it crashed
   the whole process at boot (healthcheck failure, full production outage,
   confirmed via a timed-out `/healthz` request). Fixed by setting the
   literal value directly via the Railway API. Production HTTP recovered
   immediately (`/healthz` → 200).
4. The 409 conflict continued on the NEW token, within seconds, surviving
   a full clean container restart. This ruled out a stale/zombie Railway
   container (confirmed `numReplicas: 1`).
5. **Decisive diagnostic** (commit `d170985`): shipped a build that calls
   `bot.start()` exactly once, no retry, tagging every lifecycle log with
   a random `botProcessId`. Result: a single process, first-ever attempt,
   connected successfully (`telegram bot online`) then hit a 409 ~8 seconds
   later — same `botProcessId`, no local retry involved. **This proves the
   conflict is a genuine external second poller, not this process's own
   retry lifecycle racing itself.**
6. Fixed the lifecycle regardless (commit `9b15930`): explicit
   STOPPED/STARTING/RUNNING/STOPPING/FAILED state machine, only one
   STARTING transition at a time, every retry explicitly `await`s
   `bot.stop()` before calling `bot.start()` again. This is correct
   production hygiene independent of the external cause, but **does not
   and cannot fix the external poller** — expect continued intermittent
   409 flapping (bot works for a few seconds out of every ~10) until that
   second poller is found and stopped.

**What's still unknown**: WHAT the second poller is. Exhausted from this
session's side: this Railway account (all projects/services), this dev
machine, GitHub Actions. It picked up the newly-rotated token within
seconds, which means it reads the token from somewhere both a human and
it can reach live — most plausibly another person's machine running this
bot locally (`.env` + `npm run dev`/`tsx src/index.ts`), or a forgotten
deployment on a different host from before Railway (Heroku/Render/Fly/a
VPS). Only the project owner can check either of those.

**Next session**: before anything else, ask whether anyone else has this
repo's `.env` and might be running it locally, and check for any other
hosting account predating Railway. Do NOT re-rotate the token again until
the second poller is identified — rotating without finding it just repeats
this whole incident.

## CURRENT SHAS

- `aria-engine` main: `010ffb9e5a56cb1fe524e665190c4efa7bfb633b`
- `aria-telegram-BOT-APP` main: `9b159304ff6ea45fcbeec25a658d942ba500e709`
- Both pushed and deployed 2026-09-02/03: GitHub CI green on `aria-engine`;
  Railway deployment SUCCESS for `aria-telegram-BOT-APP`
  (project `bubbly-prosperity`, service `aria-telegram-BOT-APP`).
- `TELEGRAM_BOT_TOKEN` was rotated 2026-09-03 — the value in `.env.example`
  or any local `.env` predating this date is stale.
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

## FIRST-10 PRODUCTION AUDIT (2026-09-04T00:37 UTC)

Full weighted-evidence audit run against a 42-section production-readiness
prompt. Full detail in session transcript; summary:

- OVERALL READINESS: 72/100 (PAPER product 30/35, Telegram/UX 9/20,
  production/ops 11/15, security/trust 13/15, commercial 9/15)
- FIRST-10 READINESS: 1 of 10 real users onboarded. Real count, not
  estimated.
- LIVE BETA READINESS: 0% — no LIVE code exists anywhere in aria-engine
  (grep-verified: zero PRIVATE_KEY/SEED/MNEMONIC/Keypair/sendTransaction/
  sendRawTransaction references outside tests and one file whose only
  match is a comment documenting the absence). Correctly unbuilt, not a
  gap to close.
- GO/NO-GO: FREE PAPER (existing user) GO. FREE PAPER (new-user
  onboarding) NO-GO — blocked by the Telegram bot conflict incident
  above. OWNER LIVE / TESTER LIVE: NO-GO (no LIVE code exists). PAID
  TIER: DEFER (1 user, zero payment signal).
- Third repo `AIWMCX/aria-terminal-telegram` exists but is STALE (last
  commit 2026-07-10) — a separate abandoned Vercel prototype, not part
  of current production. Do not confuse with `public/index.html` in
  this repo, which is the real, live Mini App.
- No invite/whitelist mechanism exists in code yet — the locked
  Free-Paper/Owner-Live/Approved-Tester user model is a policy, not yet
  an enforced gate. Real gap for "first 10" discipline.

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
