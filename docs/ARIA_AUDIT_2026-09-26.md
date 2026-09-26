# ARIA Solana — Production Reconciliation, Daily Health & Commercial Readiness Audit

**Audit date:** 2026-09-26 (evidence collected 2026-09-26 ~23:00–23:30 UTC)
**Product:** ARIA Solana / ARIA TG Solana Sniper — AIWMC LLC
**Mode:** evidence-first, production-first, read-only. Nothing was deployed, merged, restarted, or reconfigured by this audit.
**Branch/file:** `docs/audit-2026-09-26` → `docs/ARIA_AUDIT_2026-09-26.md` (branched from `origin/main` @ `2e4da25`)

## Evidence legend (§27)

| Tag | Meaning |
|---|---|
| `V-PROD` | VERIFIED — production evidence (live `/healthz`, Railway API) |
| `V-LOG` | VERIFIED — runtime/log evidence (Railway deployment logs) |
| `V-DB` | VERIFIED — database evidence |
| `V-TEST` | VERIFIED — test evidence only |
| `IMPL` | IMPLEMENTED — not production verified |
| `CLAIM` | CLAIMED — insufficient evidence |
| `UNK` | UNKNOWN |

**Evidence sources used in this audit:**
- `git fetch --all --prune` on both repos; `git log`, `git rev-list`, `git merge-base`, `git grep` against `origin/*` refs
- Live `GET https://aria-telegram-bot-app-production.up.railway.app/healthz` (response quoted in §G)
- Railway MCP: `list-services`, `list-deployments`, `get-service-config`, `list-variables` (names only, values redacted by the API), `get-logs` (with filters), `get-service-metrics`, `http-requests` (project `bubbly-prosperity` `4f5fba5b-…`, env `production` `fe8a169d-…`)
- Test runs executed by this audit: control-plane `npm test` and `tsc --noEmit` on a clean worktree at `2e4da25`; `aria-engine` `npm test` at `766dcdb`
- Working-tree inspection of all local worktrees (read-only)

**Evidence gaps. These were not available, so nothing here is inferred from them:**
- **Postgres:** no read access (no SQL tool for Railway Postgres; `DATABASE_URL` value redacted). Every DB statement below is `UNK` unless it is corroborated by logs or `/healthz`.
- **Telegram:** no ability to message the bot as a user. Every live-UX statement is marked `UNKNOWN — requires live human Telegram test, not performed by this audit`.
- **Analytics, Whop, social, and payments dashboards:** no access.
- **Railway log API:** returns at most ~100 lines per query. All log-derived counts are therefore lower bounds unless stated otherwise.

---

# A. EXECUTIVE PRODUCTION TRUTH

**What ARIA is today.** In production, ARIA is a Telegram bot plus a Telegram Mini App control plane (`2e4da25`, one Railway service). It issues free PAPER-beta access, pairing codes, and entitlement tokens, and it displays PAPER snapshots that a **user-run local engine** syncs up to it. Production contains **no trading engine**: `/healthz` reports `engineSha: null` (`V-PROD`). Discovery, safety checks, and PAPER trading run only on a user's own computer via the `aria-engine` CLI, which is not deployed anywhere.

**What genuinely works (verified this session):**
- The control plane is up. It is the same process since 2026-09-19 19:05 UTC, with one `processBootId` (`7abbcf00…`) and zero restarts in 7 days (`V-PROD`, `V-LOG`).
- The deployed SHA equals `origin/main` equals the Railway deployment (`2e4da25`, deployment `4025dcce`) (`V-PROD`).
- The bot receives and logs real Telegram updates: 10 logged in 7 days (`V-LOG`).
- A trial lead was issued to a real non-founder user on 2026-09-24 (lead 4) (`V-LOG`).
- Both repos' test suites pass: control plane 117 ✅ / 0 ❌ with typecheck clean; engine 1,368 ✅ / 0 ❌ across 75 files (`V-TEST` only).

**What changed since the last audit (2026-09-19):**
- **No code moved.** There are zero new commits on any branch of either repo since 2026-09-19 18:38 MDT. Production was not redeployed.
- The only new work is **uncommitted**: a third fix cycle for the hosted entitlement-renewal fix, edited today (2026-09-26 ~17:15 MDT) in the `aria-telegram-BOT-APP-hosted-impl` worktree. Its code comments refer to a second independent review that FAILED. That failure is not recorded in the committed ledger.
- The most important change is operational, and it was found by this audit rather than shipped. The long-running "unidentified second poller" that has been breaking Telegram delivery since 2026-09-03 is **identified: it is ARIA's own `aria-real1-preview` Railway service.** Separately, **the production webhook secret is being written to production logs in plaintext.**

**What doesn't work:**
- **Telegram delivery is intermittent.** The production webhook was found **unset in at least ~3,025 of its 30-second health checks** since 2026-09-20 (roughly 25 hours, ~15% of checks). At least one real update (`574790448`) never reached production (`V-LOG`).
- **License emails fail for every non-founder.** Resend is in testing mode, so it only delivers to the founder's own address (`V-LOG`, 2026-09-24).
- **There is no hosted PAPER in production.** Users must install a local CLI, obtain an invite, and pair. The hosted-engine program is still unmerged across three diverging branches.
- Payments are disabled (`paymentsEnabled:false`), and no storefront was found in any repo.

**Live vs paper boundary:**
- **Production:** no transaction construction, simulation, signing, submission, or confirmation exists (`V-PROD` by absence plus a code sweep).
- **`aria-engine`:** observes real Solana mainnet data (public RPC by default) and executes **simulated PAPER fills only**, on the user's machine.
- **LIVE Milestone 1:** a backend-only state machine and firewall with no signing. It is unmerged and unwired.

**Biggest risk:** the same finding in two parts.
1. A stale, 23-day-old build from a non-`main` branch (`codex/real-1-preview-current-main` @ `c0f7822`) is running in production with the production bot token, both signing keys, and a `DATABASE_URL`. It steals updates from real users and may answer them with outdated code.
2. The production webhook secret is in the logs. Together with the public admin Telegram ID, that is a path to **forging admin commands**.

**Next milestone:** restore reliable, authenticated Telegram delivery by removing the bot token from the preview service, redacting and rotating the webhook secret, and proving 24 hours with zero `TELEGRAM_WEBHOOK_MISMATCH`. Only then resume the hosted-PAPER merge.

---

# B. SINCE-LAST-AUDIT CHANGE LEDGER (§1 + §2)

## B.1 PREVIOUS_VERIFIED_STATE (baseline)

| Field | Baseline value | Source |
|---|---|---|
| Audit timestamp | 2026-09-19 (convergence doc generated same day; ledger last entry 2026-09-19 18:38 MDT) | `docs/ARIA_PRODUCTION_CONVERGENCE.md` @ `ef504f5` (branch `docs/production-convergence-2026-09-19`, unmerged); hosted-engine LEDGER @ `f9fd402` |
| Control-plane SHA / branch | `2e4da2526a2e…` / `main` | convergence Part 1 |
| Deployment | Railway `4025dcce-c067-41d0-8083-bc6ad5c2b93d`, SUCCESS, 2026-09-19T19:05:09Z | convergence Part 1 |
| Production URL | `https://aria-telegram-bot-app-production.up.railway.app` | convergence |
| Engine in prod | none — `engineSha: null` | convergence |
| Engine `main` | `766dcdb` (commercialization + `ARIA_RUNTIME_DIR` merged) — MERGED_NOT_DEPLOYED | convergence |
| Known-good | control plane alive; `/healthz` release identity; webhook "self-healing" (`TELEGRAM_WEBHOOK_OK` every 30s over a ~30-min window) | convergence Part 2/3 |
| Known failures / blockers | hosted pairing-state seeding P0 (fixed on branch, REVIEWED-PASS); entitlement renewal (fix `8f59d62` awaiting review); Task 5 unreviewed; Task 6 third review pending; `ARIA_ENGINE_COMMIT_SHA` + fetch credential absent from Railway | convergence + ledger |
| Security concerns | LIVE branches would revert `2e4da25` if merged un-rebased; meta description "sniper" UNSUPPORTED | convergence Part 5 |
| Telegram state | webhook transport; 16 commands; `/start` not runtime-exercised | convergence |
| Paper/live state | PAPER-only everywhere; LIVE M1 backend reviewed PASS, unmerged | convergence |
| Market-data state | engine-only (not deployed) | convergence |
| DB / analytics | `funnel_events` deployed, never queried; `/healthz leads: 3` | convergence |
| User activity | memory file (2026-09-03): "One real external user … full pairing→PAPER→restart flow" | `aria_sniper_launch_readiness` memory |
| Commercial | free PAPER BETA; `paymentsEnabled:false` | convergence |
| Open incident (older) | TELEGRAM BOT CONFLICT INCIDENT (2026-09-03): "MITIGATED, ROOT CAUSE UNRESOLVED"; `aria-real1-preview` recorded as "ruled out" | `docs/ARIA_PRODUCT_SCALE_STATE.md:404–460` on `main` |

## B.2 Exhaustive change ledger, 2026-09-19 18:38 MDT → 2026-09-26

| Time (UTC) | Operation | Source | Component | Previous state | New state | Production impact | Evidence | Verified? |
|---|---|---|---|---|---|---|---|---|
| 2026-09-19 → 09-26 | **No commits on any branch, either repo** | git | both repos | last commit `f9fd402` (bot) / `766dcdb` (engine) | unchanged | none | `git for-each-ref --sort=-committerdate refs/remotes` after `fetch --prune`: newest ref is `origin/fix/hosted-entitlement-renewal` 2026-09-19 18:38:07 -0600 | `V-PROD` (git) |
| 2026-09-19 → 09-26 | **No deployments** | Railway | `aria-telegram-BOT-APP` | `4025dcce` SUCCESS | same, still the only non-REMOVED deployment | none | `list-deployments`; `/healthz` `uptime` 619,811 s ≈ 7.17 d; single `processBootId 7abbcf00…` in every log line | `V-PROD`, `V-LOG` |
| 2026-09-19 → 09-26 | No Railway variable changes observed | Railway | prod service | 37 names (per convergence) | 37 names (identical set, incl. `RUN_SYNC_DESYNC_REPRO`, no `ARIA_ENGINE_COMMIT_SHA`) | none | `list-variables` | `V-PROD` (names only) |
| 2026-09-26 ~23:05 (17:15 MDT) | **Uncommitted third fix cycle for entitlement renewal** | local worktree `aria-telegram-BOT-APP-hosted-impl` | `src/fleet/hosted-pairing-seed.ts` (+102/−39 lines incl. test) | committed `8f59d62` "awaiting review" | working-tree edits: sign-before-re-read reordering; `testHooks.afterReadBeforeWrite` seam; D2 test rewritten to write *inside* the read→write window; docblock discloses symmetric race | none (uncommitted, unpushed) | `git diff` in that worktree; file mtimes 2026-09-26 17:15:07/17:15:57 -0600 | `IMPL` (not committed, not reviewed) |
| (inferred, undated) | **Second independent review of renewal fix FAILED** | code comments in the uncommitted diff | renewal fix `8f59d62` | ledger: "IMPLEMENTED (awaiting review)" | FAIL on Defect 1 (vacuous D2 test: "passed even with the re-read deleted entirely") and Defect 2 (signing inside race window) | none | only source is comment text in the uncommitted diff; **not recorded in the committed ledger** | `CLAIM` |
| 2026-09-19 → 09-26 | Task 6 (Fleet soak) third independent review | ledger | hosted program | "third review needed" | **no record of outcome anywhere** | none | ledger @ `f9fd402` Task 6 row unchanged; no commits | `UNK` |
| 2026-09-20 01:11 → 09-26 23:17 | **Recurring webhook hijack, ~every 2–3 h** | runtime | prod Telegram ingress | convergence saw 30 min of clean `TELEGRAM_WEBHOOK_OK` | ≥100 `TELEGRAM_WEBHOOK_HELD` reclaim events after runs of up to 51 consecutive mismatches | **real: updates lost/diverted** | `get-logs` filter `TELEGRAM_WEBHOOK_HELD` (100 events 09-20 01:43 → 09-26 22:21) | `V-LOG` |
| 2026-09-20 → 09-26 | `setWebhook` 429/502/409 bursts | runtime | prod | — | 25+ `TELEGRAM_WEBHOOK_REASSERT_FAILED` (429 rate-limit from the 3 s reassert loop; 409 "terminated by other setWebhook") | self-rate-limiting against Telegram | `get-logs` | `V-LOG` |
| 2026-09-20 → 09-26 | **Webhook secret written to logs in plaintext** | runtime | prod logging | — | every `TELEGRAM_WEBHOOK_REASSERT_FAILED` line carries `payload.secret_token` | secret exposure | `get-logs` (value not reproduced here) | `V-LOG` |
| 2026-09-20 15:42 → 09-26 17:34 | 10 Telegram updates received | runtime | bot | — | update_ids `574790439`–`447`, `449` (**`448` missing**) | real user traffic | filter `TELEGRAM_UPDATE_RECEIVED` | `V-LOG` |
| 2026-09-24 21:23 | Trial issued, lead 4 (`lic_22480c4d688c`) | runtime | licence flow | `/healthz leads: 3` | `leads: 4` | real new lead | log `trial issued`; `/healthz` | `V-LOG`, `V-PROD` |
| 2026-09-24 21:23 | **Licence email failed (Resend 403 testing-mode)** | runtime | email | — | "can only send testing emails to your own email address" | user never gets the email | log `license email failed` | `V-LOG` |
| continuous | `aria-real1-preview` polling with prod bot token | runtime | preview service | incident doc: "ruled out" | logs: `telegram bot online` (bot id `8824521461`) then `409 terminated by setWebhook request`, retry every 5 s | **root cause of the hijack** | preview `get-logs`, deployment `9bf591be` | `V-LOG` |

**Net since last audit:** production is byte-identical. The real changes are (a) degraded runtime behaviour and (b) one uncommitted fix cycle. Every other claim of progress is repository activity dated on or before 2026-09-19.

---

# C. WORKFLOW → PRODUCT TRANSLATION (§3)

| Internal/workflow language | Technical meaning | User-visible meaning | Commercial meaning | Evidence | Limitation |
|---|---|---|---|---|---|
| "Renewal fix, third cycle in progress" | Uncommitted edits to `renewHostedPairingStateIfNeeded`, closing a race-window test gap | none | none. It protects a future hosted-PAPER user from being locked out on day 8 or un-revoked | worktree diff | uncommitted, unreviewed, on a branch that does not contain packaging |
| "Hosted PAPER engine program (Tasks 1–7 + 2 P0s)" | Server-side Fleet Manager spawning per-user `aria-engine` processes | none today. Future: "start PAPER from Telegram, no install" | the single largest activation unlock in the backlog | ledger | 0% in prod; branches diverge (§L P1-2) |
| "LIVE Vertical Slice M1 PASS" | State machine, firewall, and schema for future non-custodial real-money trading | none | none today; it shows seriousness about safety to acquirers | branch `cb94f9a` | no signing, no submission, unmerged; reverts `2e4da25` if merged as-is |
| "Webhook self-healing / reassert loop" | `setWebhook` every 3 s, `getWebhookInfo` every 30 s | the bot "sometimes doesn't answer" | lost first impressions | `src/index.ts:196–236` | a mitigation fighting ARIA's own preview service; it causes 429s |
| "Build-identity `/healthz`" | SHA/buildTime/releaseId in `/healthz` | none | makes release claims auditable | live response | engine half is `null` |
| "Commercial PAPER audit/certification (engine Task 9)" | CLI command summarising a PAPER session's evidence | none (engine not hosted) | a future "verified paper results" artefact | engine `8656b81` | never run against real users' sessions in prod |
| "Research-derived additions" (Jito PAPER cost model, execution-cost envelope, progressive/trailing exits, FOMO engine, cross-source price agreement) | deterministic cost and exit heuristics in the engine | none in prod | **awaiting validation.** No measured effect on PAPER realism or outcomes exists | engine tests only | no production data; §F |

---

# D. CURRENT PRODUCTION ARCHITECTURE (§4)

```
Telegram user
  └─► Telegram Bot API ──(webhook, intermittently hijacked)──► aria-telegram-BOT-APP @2e4da25 (Railway, 1 replica, sfo)
  │                        └─(when webhook deleted)──► aria-real1-preview @c0f7822 (Railway, polling, STALE)  ◄── §L P0-1
  ├─ /start /license /status /licensekey /pair /support /notifications /help (+ admin: /stats /invite /invites /beta /attribution /feedback /revoke /revokeengine)
  ├─ Mini App (public/index.html) ─► Hono API (/api/auth/telegram, /api/submit, /api/engine/*, /api/interest, /api/feedback)
  ├─ SQLite (/data volume: leads/licenses/audit_log)  +  Postgres (users/invites/engine_*/funnel_events/feedback)
  └─ Resend (email, TESTING MODE)            Stripe (code present, paymentsEnabled:false)

User's own computer (NOT production):
  aria-engine CLI @766dcdb ─► public mainnet RPC (api.mainnet-beta.solana.com) + Jupiter lite price API + Raydium price API
     └─ discovery (Pump, PumpSwap, Raydium LaunchLab/CPMM/CLMM, Meteora DBC) ─► 12 safety checks ─► eligibility ─► PAPER fill ─► position/exit ─► PnL
     └─ signed sync (Ed25519 device key + ARIAE1 entitlement) ─► control plane /api/engine/sync ─► Mini App display
```

| Component | Status | Source of truth | Evidence |
|---|---|---|---|
| Telegram webhook ingress | **PROD PRESENT, DEGRADED** | `src/index.ts` `verifyWebhookOnBoot` | §G logs |
| Command handling (`bot.ts`, 16 commands) | PROD VERIFIED (receipt only) | `src/bot.ts` | `TELEGRAM_UPDATE_RECEIVED` with `/start`, `/license` |
| Command *responses* | UNKNOWN — requires live human Telegram test, not performed by this audit | — | no outbound-reply log line exists |
| Mini App | PROD PRESENT BUT UNVERIFIED | `public/*` | served by `server.ts` catch-all (not opened this audit) |
| Trial/licence issuance | PROD VERIFIED | `licenses.ts` | log `trial issued` lead 4 |
| Licence email delivery | **BROKEN** for non-founders | `email.ts` + Resend | log 403 testing-mode |
| Pairing / entitlement issuance | PROD PRESENT BUT UNVERIFIED this week | `server.ts /api/engine/*` | no pairing log lines in the 7-day window |
| Candidate discovery | LOCAL ONLY (engine) | `aria-engine/src/discovery` | engine not in image |
| Solana/RPC/price providers | LOCAL ONLY | `runtime-config.ts:53`, `jupiter-price-source.ts:16`, `raydium-price-source.ts:21` | code |
| Screening/safety/eligibility | LOCAL ONLY | `src/safety/*`, `src/strategy/*` | code + tests |
| Risk | LOCAL ONLY / PAPER ONLY | `paper-risk.ts`, `paper-config.ts` | code |
| Paper execution | LOCAL ONLY / PAPER ONLY | `paper-fill.ts` | code + tests |
| Live execution | NOT IMPLEMENTED (prod); backend-only on unmerged branch | `impl/live-vertical-slice-0.1-milestone-1` | code sweep |
| Positions/PnL | LOCAL ONLY (engine); display PROD PRESENT BUT UNVERIFIED | `paper-accounting.ts`; `public/app.js` | code |
| Hosted Fleet Manager | NOT IN PROD (branch only) | `src/fleet/*` on branches | `git grep paper_start origin/main` → none |
| Monitoring | log lines only; **error severity lost** (§M) | Railway logs | logger.error lines appear as `severity: info` |
| Analytics | PROD PRESENT BUT UNVERIFIED (`funnel_events`) | `src/funnel.ts` | not queryable by this audit |
| `aria-real1-preview` | **BROKEN / HAZARD**: stale build running in prod env | Railway | §L P0-1 |

---

# E. PRODUCTION RECONCILIATION (§10)

| Claim | Where | Code exists | Deployed | Runtime verified | User accessible | Production truth |
|---|---|---|---|---|---|---|
| "ARIA Solana sniper control center" | `public/index.html:9` meta | n/a | yes | n/a | yes (link previews) | **MARKETING DRIFT.** Nothing snipes; no engine in prod (carried forward, unfixed) |
| "Solana mainnet market data · Paper execution · No real orders · No custody" | `bot.ts:113` `/start` | yes | yes | reply not observed | yes | Accurate *for the local engine*. Production itself shows data only if a user runs the engine |
| "Fill the form … You'll get your license instantly" | `bot.ts` `/start` | yes | yes | licence issued (`V-LOG`); **email failed** | partially | **PRODUCTION DRIFT.** "Instantly" holds only in-app; the email never arrives for non-founders |
| Paid tiers / Stripe $149/$449 | `CLAUDE.md` | code yes | `paymentsEnabled:false` | n/a | no | **DOCUMENTATION DRIFT.** `CLAUDE.md` still describes a paid sniper; the product is a free PAPER beta |
| "Webhook self-healing: PRODUCTION_VERIFIED" | convergence doc | yes | yes | ≥25 h unset in 7 d | — | **was true for a 30-min window, false over a week** |
| "`aria-real1-preview` ruled out" as the second poller | `ARIA_PRODUCT_SCALE_STATE.md:414` | — | — | **refuted by preview logs** | — | **DOCUMENTATION DRIFT + CONFIGURATION DRIFT.** The check read `startCommand`, not the running deployment |
| "still-unidentified external process" | `src/index.ts:170–185` comments | — | — | refuted | — | same |
| "One real external user" | memory (09-03) | — | — | 3 distinct non-founder Telegram IDs sent updates in 7 days | — | superseded; see §H for what those IDs did and did not do |
| Hosted `/paper_start` | ledger / branches | yes (branch) | **no** | no | no | branch-only |
| LIVE trading | LIVE spec / M1 | backend only | no | no | no | not a product capability |
| Entitlement renewal "awaiting review" | committed ledger | yes | no | no | no | **TEST DRIFT.** Per the uncommitted diff, the review failed on a vacuous test |
| "Revocation before 7-day expiry not enforced" | `CLAUDE.md` | — | — | — | — | not re-verified this audit (`UNK`) |
| Engine test suite green | engine repo | yes | n/a | 1,368 ✅ | n/a | `V-TEST` only |

---

# F. TRADING SYSTEM STATE (§5, §6, §7, §8, §13)

## F.1 Paper vs live hard boundary (§5)

| Stage | Production | Engine (user machine) | LIVE M1 branch |
|---|---|---|---|
| Market observation (real mainnet) | none | yes: public RPC + Jupiter + Raydium price APIs (`IMPL`, `V-TEST`) | n/a |
| Candidate generation | none | yes: 6 decoders registered `cli.ts:364` (`IMPL`) | n/a |
| Signal generation | none | deterministic eligibility + safety (`IMPL`) | n/a |
| Paper execution | none | yes (`IMPL`, `V-TEST`) | n/a |
| 1 construct tx | **no** | **no** (PAPER never builds one; `paper-config.ts` comments) | no route builder |
| 2 simulate | no | no | no |
| 3 sign | no. `signTransaction` exists only in `src/signer-port.ts` (interface) and `src/signer-adapters/stub-signer-adapter.ts` (TEST-ONLY stub, unimported by prod code) | no (`contracts.ts:5` explicitly no signing) | no |
| 4 submit / 5 signature / 6 confirm / 7 reconcile / 8 recover | no | no | schema/state only |

**The boundary stops before step 1.** No component anywhere can construct a Solana transaction. "Live trading" is `NOT IMPLEMENTED`.

**Paper fill assumptions** (`aria-engine/src/paper/paper-config.ts`, `paper-fill.ts`, `jito-paper-model.ts`):
- **Size:** buy 0.005 SOL; max 3 positions; 0.015 SOL exposure cap.
- **Fees and slippage:** fee 100 bps (overridable per candidate via `feeOverrideBps`); slippage a **flat 100 bps**, independent of trade size and pool depth.
- **Priority fee and tip:** priority fee 5,000 lamports and Jito tip 100,000 lamports. Both are *configured estimates*, not observed values.
- **Latency:** 400 ms simulated, plus 50 bps/s of adverse movement.
- **What is not modelled:**
  - price impact from pool reserves in the fill (the quote price may be curve-derived, but the fill applies flat bps)
  - failed or dropped transactions (fills always succeed)
  - MEV or sandwich attacks
  - liquidity or pool-depth limits on size
  - stale-quote rejection at fill time, beyond the safety-stage `StalenessCheck` (15 s `maxAgeMs`)

## F.2 Solana data integrity (§6)

| Data | Provider | Endpoint | Auth | Retry/fallback | Stale detection | Status |
|---|---|---|---|---|---|---|
| Blocks, txs, accounts, mint/freeze authority, holders, balances | Solana JSON-RPC | default `https://api.mainnet-beta.solana.com`, `fallbackUrls: []` (`runtime-config.ts:53`) | none (public) | failover module exists (`solana-rpc-failover.test.ts`); default config has **no fallback** | n/a | LOCAL ONLY |
| Price | Jupiter | `https://lite-api.jup.ag/price/v3` | none | — | `StalenessCheck` 15 s | LOCAL ONLY |
| Price (second source) | Raydium | `https://api-v3.raydium.io/mint/price` | none | — | cross-check via `price-source-agreement-check.ts` | LOCAL ONLY |
| Discovery events | RPC polling (`PollingRpcTransport`) | same RPC | none | — | — | LOCAL ONLY |

**Ways this could produce a false candidate or a wrong result** (`IMPL`; none measured in production):
1. **Public mainnet RPC as the default.** It is rate-limited, per-IP, and has no SLA; a 429 can drop discovery events. Engine tests assert "an RPC failure is UNKNOWN, not silently treated as PASS", which is good fail-closed behaviour (`V-TEST`). But **missed events** create survivorship bias, not false positives.
2. **Flat-bps fills** overstate PAPER PnL on thin pools where real price impact is larger than 1%.
3. **No observed fee or priority-fee data.** PnL uses configured estimates.

Out-of-order, duplicate, or missing events, websocket reconnects, and decimal handling could not be tested against production, because none of this runs in production. `UNK`.

## F.3 Candidate engine pipeline (§7)

`SOURCE (6 program decoders) → DISCOVERY (DiscoveryEngine, PollingRpcTransport) → NORMALIZATION (candidate-id, dedup) → FILTERS/SAFETY (12 evaluators via evaluate-candidate.ts) → ELIGIBILITY (candidate-eligibility.ts) → PAPER DECISION (paper-risk.ts) → POSITION (paper-position.ts) → EXIT (TP +80% / SL −25% / max-age 900 s / trailing off / progressive optional) → PNL (paper-accounting.ts)`

- **All rules are deterministic and config-driven.** No model-generated scoring was found.
- **Dead or partial logic:**
  - `"emergency"` exit mode is an alias of `"full"` (`paper-progressive-exit.ts:46`): an accepted enum value with no distinct behaviour. Carried forward.
  - `trailingStopBps: 0` by default: trailing exits are off.
- **Research-derived additions** are all **awaiting validation**: FOMO/momentum engine, Jito PAPER cost model, execution-cost envelope, progressive exits, cross-source price agreement, creator-funding check.
  - None has production data.
  - None has a measured before/after on PAPER realism or outcome.
  - Most are sophistication without evidence of improvement yet. The exceptions are price-source agreement and staleness, which are plausibly real risk controls because they fail closed.

## F.4 Risk engine (§8)

| Control | Implemented | Enforced in production | Tested against failure |
|---|---|---|---|
| Max positions 3 / exposure 0.015 SOL / daily loss 0.015 SOL | yes (`paper-config.ts`, `paper-risk.ts`, `paper-exposure-ledger.ts`) | **no** (no engine in prod) | `V-TEST` |
| Mint cooldown 300 s (duplicate-entry) | yes | no | `V-TEST` |
| TP/SL/max-age | yes | no | `V-TEST` |
| Stale-price rejection (15 s) | yes | no | `V-TEST` |
| Mint/freeze authority, holder concentration, liquidity, sellability, metadata mutability, creator history/funding, duplicate mint, social | yes | no | `V-TEST` |
| Hard stop / kill switch | `paper-hard-stop.ts` + desired-state file | no | `V-TEST` |
| Tx simulation, balance validation | n/a (PAPER) | n/a | n/a |

**Bypass paths:** the controls are enforced in the engine. Nothing in production executes trades, so no production bypass exists. Every control is **user-machine-local**: the user owns the process and its config. For a *hosted* engine that stays true of the config env vars; the LIVE M1 firewall (F0–F21) is the only design that treats this as adversarial.

## F.5 PnL / accounting (§13)

- **Production displays PnL** only from a user-synced engine snapshot (`public/app.js`). No snapshot was observed this week, and nothing could be reconstructed.
- **Engine PnL formula** (`paper-accounting.ts`): entry cost = buy + fee + fixed execution cost; exit proceeds = qty × mark × (1 − slippage) − fee.
  - **Observed values:** mark prices, from real APIs.
  - **Estimated values:** fees, priority fee, tip, slippage, latency.
  - **Not modelled:** failed executions, price impact.
- **No historical performance number exists in production.** Any PAPER PnL figure a user sees is **simulated**, with a flat-slippage assumption and no failed-transaction modelling.

---

# G. DAILY HEALTH (§11, §12, §15)

## G.1 Deployment health (§11)

| Item | Value | Evidence |
|---|---|---|
| Deployed SHA | `2e4da2526a2ed0a565641eca9efd2854d7cb83b7` | `/healthz` `release.controlPlaneSha` |
| Repo `main` | `2e4da25` | `git rev-parse origin/main` |
| Railway deployment | `4025dcce-c067-41d0-8083-bc6ad5c2b93d`, SUCCESS, created 2026-09-19T19:05:09Z, commit `2e4da25`, branch `main`, region `sfo`, 1 replica, volume `/data` | `list-deployments`, `get-service-config` |
| HEAD vs deployed vs running | **identical** | three sources agree |
| Age | ~7.2 days, no restart | `uptime` 619,811 s; one `processBootId` |
| Engine | `null` | `/healthz` |
| Required secrets | present by name: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ARIA_ENTITLEMENT_PRIVATE_D`, `ARIA_LICENSE_PRIVATE_D`, `DATABASE_URL`, `RESEND_API_KEY`; absent: `ARIA_ENGINE_COMMIT_SHA`, Stripe keys | `list-variables` |
| Resource use | CPU ~0.001 vCPU avg, memory ~0.151 GB flat | `get-service-metrics` |
| HTTP (last 1 h) | 1 request, 1× 2xx | `http-requests` |
| Error-level logs | **0 returned by `@level:error` filter, even though code logs errors.** Severity mapping loses errors | §M-3 |

Live `/healthz` (verbatim):

```json
{"ok":true,"uptime":619811.108675089,"leads":4,"paymentsEnabled":false,"release":{"controlPlaneSha":"2e4da2526a2ed0a565641eca9efd2854d7cb83b7","branch":"main","buildTime":"2026-09-19T19:05:34Z","releaseId":"2e4da2526a2e@2026-09-19T19:05:34Z","mode":"paper","engineSha":null}}
```

## G.2 Database / state health (§12)

| Item | Status |
|---|---|
| Postgres service | exists (`Postgres`, same project). Schema, migrations, row counts: `UNK` (no DB access) |
| SQLite leads | `leads: 4` (`V-PROD` via `/healthz`); +1 since 09-19 |
| Migration drift | branch-only migrations exist (`1789169021631_add-engine-clients-hosting-mode.js` on hosted branches; `1758240000000`/`1758250000000` LIVE). Not applied to prod per code; **whether `aria-real1-preview`'s startup `runPgMigrations()` applied old or other migrations to a shared DB is `UNK`**, because the `DATABASE_URL` values are redacted and cannot be compared |
| Duplicates/orphans/impossible states/stale positions/invalid PnL | `UNK`. Requires DB read. No position or PnL state is held in prod anyway (engine is local) |
| Reconciliation vs logs | 1 `trial issued` log (lead 4) is consistent with `leads` 3→4 |

## G.3 Daily health snapshot (§15)

| Area | Item | State | Basis |
|---|---|---|---|
| Infra | Deployment | HEALTHY | §G.1 |
| Infra | Backend process | HEALTHY | uptime, metrics |
| Infra | DB | UNKNOWN | no access; `/healthz` ok |
| Infra | Telegram | **DEGRADED** | ≥100 hijack/reclaim cycles; update `448` lost; 429s |
| Infra | Solana RPC | UNKNOWN (not in prod) | — |
| Infra | Data providers | UNKNOWN (not in prod) | — |
| Infra | Workers/scheduled jobs (expiry warnings, offline alerts) | UNKNOWN | no log lines observed |
| Infra | Email (Resend) | **BROKEN** for non-founder recipients | 403 testing-mode |
| Product | Onboarding | DEGRADED | `/start` received; email fails; next step needs local CLI + invite |
| Product | Monitoring (Mini App) | UNKNOWN | not exercised |
| Product | Candidate generation | BROKEN in prod (does not exist); local-only | engineSha null |
| Product | Paper execution / positions / PnL / history | BROKEN in prod (not present); local-only | same |
| Reliability | Errors | UNKNOWN (severity mapping hides them) | §M-3 |
| Reliability | Webhook failures | **DEGRADED** | §B |
| Reliability | Crashes | HEALTHY (0 restarts in 7 d) | one boot id |

---

# H. USER ACTIVITY (§16)

**Source:** `TELEGRAM_UPDATE_RECEIVED` production log lines. This is a lower bound: updates delivered while the webhook was hijacked went to the preview service and are **invisible** here. `funnel_events` was not queryable.

`7597208041` is the admin/founder identity (per `docs/ARIA_PRODUCT_SCALE_STATE.md:360`).

| Window (ending 2026-09-26 ~23:20Z) | Updates received by prod | Unique Telegram IDs | Non-founder unique IDs | `/start` events | Trial/licence issued |
|---|---|---|---|---|---|
| 24 h | 1 (`449`, founder `/start`) | 1 | **0** | 1 (founder) | 0 |
| 3 d | 6 (`443`–`447`, `449`) | 3 | **2** (`8550898309`, `8575293893`) | 3 | 1 (lead 4, 09-24) |
| 7 d | 10 (`439`–`447`, `449`) | 4 | **3** (`1338357045`, `8550898309`, `8575293893`) | 4 (3 non-founder) | 1 |
| 30 d | NOT MEASURABLE (deployment is 7 d old; the per-deployment log API does not span earlier deployments) | — | — | — | — |

**Known-missing:** update_id `574790448` (between 09-24 21:25Z and 09-26 17:34Z) never reached production.

**Funnel: BOT START → ONBOARDING → TERMINAL → CANDIDATE VIEW → PAPER ACTION → POSITION → RETURN**
- **Bot start:** 3 non-founder IDs in 7 d (`V-LOG`).
- **Onboarding:** 1 of those 3 completed the trial form (`8575293893`: `/start` → `/license` → trial issued; `V-LOG`).
- **Terminal open, candidate view, paper action, position, return:** **NOT MEASURABLE.**
  - No log event exists for Mini App opens or engine sync in the returned window.
  - `funnel_events` exists but could not be read.
  - Engine sync lines were not observed. Absence from a ~100-line log sample is not proof of zero.
- **Paid users:** 0 (payments disabled; `V-PROD`). This is a zero, not an unknown.

**Minimum instrumentation needed:**
1. A read-only `/admin/funnel` endpoint or scheduled log line that emits `getFunnelCounts()` daily (the table and function already exist).
2. Log lines for Mini App auth (`/api/auth/telegram`), pairing-code issued/redeemed, and first engine sync per client.
3. Update-ID gap detection: log whenever `update_id` is not `previous + 1`. This would have made the hijack visible as lost updates.

---

# I. SALES & DISTRIBUTION (§17)

| Stage | Number | Evidence |
|---|---|---|
| Impressions / clicks / social | NOT MEASURABLE | no analytics access |
| Whop storefront | **not found**. Zero references to "whop" on any branch of either repo | `git grep -i whop` |
| Telegram entry → START | 3 non-founder starts / 7 d (lower bound) | §H |
| Activated user (engine paired + PAPER running) | NOT MEASURABLE this week. Memory records 1 historic external user (2026-09-03) | memory; no sync logs observed |
| Repeat user | NOT MEASURABLE | — |
| Paid user | **0** | `paymentsEnabled:false` |
| Revenue | **$0** from ARIA software (no payment path enabled) | `/healthz` |
| Inbound inquiries / waitlist | `POST /api/interest` (live/paid interest) deployed; counts NOT MEASURABLE | code |
| Invites | first-10 beta invite system deployed; issuance counts NOT MEASURABLE | code |

A Telegram `/start` is not an active user, and interest capture is not a customer.

---

# J. SECURITY (§14)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| J-1 | **`TELEGRAM_WEBHOOK_SECRET` is written in plaintext to production logs.** Every `TELEGRAM_WEBHOOK_REASSERT_FAILED` line serialises the grammy error, including `payload.secret_token`. Since 2026-09-20 at least ~25 such lines exist. This secret is the **only** authentication on `POST /api/telegram/webhook` (`server.ts:43–47`, grammy `webhookCallback` `secretToken`). Admin commands authorise on `ctx.from.id === ADMIN_TELEGRAM_CHAT_ID` (`bot.ts:49–51`). The admin ID is present in the repo (`ARIA_PRODUCT_SCALE_STATE.md:360`) and in the same logs. **Anyone holding the secret can forge an update as the admin and run `/revoke`, `/revokeengine`, `/invite`, `/beta`, `/stats`, `/attribution`, or `/feedback`** (`/stats` exposes lead data). Exposure is limited to parties with Railway log access; that includes any MCP-connected agent, and this audit read it. **Value not reproduced in this report.** | **P0** | `get-logs` filter `-TELEGRAM_WEBHOOK_OK …`; `src/index.ts:201–205` (`logger.error({ err }, …)`) |
| J-2 | **A stale service holds production secrets.** `aria-real1-preview` (branch `codex/real-1-preview-current-main` @ `c0f7822`, 2026-09-03) has `TELEGRAM_BOT_TOKEN`, `ARIA_ENTITLEMENT_PRIVATE_D`, `ARIA_LICENSE_PRIVATE_D`, `DATABASE_URL`, and `RESEND_API_KEY`. It has a public domain `aria-real1-preview-production.up.railway.app` and is actively consuming the production bot's updates (bot id `8824521461` logged). It is old code handling real users, and a second copy of the signing keys. Whether its token/keys/DB equal production's values is proven for the bot token (409 "terminated by setWebhook request" can only come from the same token) and `UNK` for the others (values redacted). | **P0** (with §L P0-1) | preview `get-logs`, `list-variables`, `get-service-config` |
| J-3 | No private keys, seed phrases, or signing in prod. `signTransaction` exists only as an interface plus a TEST-ONLY stub | OK | `git grep` sweep |
| J-4 | Secrets in Git history: sweep for Telegram-token, Stripe `sk_`, and Resend `re_` patterns across `--all` history of both repos found only a test placeholder | OK | `git log --all -p \| grep -a -E …` |
| J-5 | Telegram `initData` HMAC verification for Mini App API (`telegram-auth.ts`) | IMPL, not re-tested | code |
| J-6 | Entitlement revocation gap for hosted-only tenants (no `engine_entitlements` row → `/revokeengine` has no UUID) | open on branch (ledger follow-up 1) | ledger |
| J-7 | Renewal fix D1 (revocation-cache wipe) is fixed on branch but **second review FAILED** per the uncommitted diff; the third cycle is uncommitted | release-blocking for hosted | §B |
| J-8 | `CLAUDE.md` instructs contributors to keep private keys in Railway vars. Correct, but the preview duplication shows no inventory of *where* keys live | P2 | J-2 |

Real transaction signing is not being introduced anywhere on `main`. Key management for LIVE remains release-blocking and unstarted, by design.

---

# K. REGRESSIONS (§23)

| Capability previously VERIFIED | Result | Evidence |
|---|---|---|
| Control-plane SHA chain (main = Railway = `/healthz`) | **STILL VERIFIED** | §G.1 |
| Build-identity `/healthz` | **STILL VERIFIED** | live response |
| Webhook transport / self-healing ("`TELEGRAM_WEBHOOK_OK` every 30 s") | **REGRESSED** (or never held beyond the 30-min sample). ≥100 hijack episodes over 7 d | §B |
| Telegram startup (`/start` received) | STILL VERIFIED (receipt); reply content NO LONGER TESTABLE by this audit | logs |
| DB connectivity | STILL VERIFIED indirectly (`/healthz` ok, lead insert logged) | logs |
| Engine restart recovery (memory, 2026-09-02) | NO LONGER TESTABLE in prod (engine local-only; no sync observed) | — |
| Candidate retrieval / data freshness / paper entry / exit / PnL | NO LONGER TESTABLE (never in prod) | — |
| RPC reconnect | NO LONGER TESTABLE (not in prod) | — |
| Access control (admin, invite gate) | STILL IMPLEMENTED. **Now bypassable** via forged webhook updates using the leaked secret (J-1) | code + logs |
| Licence email delivery | **REGRESSED / BROKEN** for non-founders (no prior verified baseline found; first observed failure) | log 2026-09-24 |
| Engine test suite | STILL VERIFIED (`V-TEST`) | 1,368 ✅ |
| Control-plane test suite | STILL VERIFIED (`V-TEST`) | 117 ✅, typecheck clean |

---

# L. BLOCKERS (§20)

**Headline counts: P0 = 2, P1 = 4, P2 = 5, P3 = 5.**

## P0 — release / security

**P0-1: A stale preview service is hijacking production Telegram delivery.**
- **Evidence:**
  - `aria-real1-preview` active deployment `9bf591be` (SUCCESS 2026-09-03; newer `20aa887a` FAILED, so the old one keeps running) logs `telegram bot online` for bot `8824521461`, then `409: Conflict: terminated by setWebhook request`, retrying every 5 s. grammy's `bot.start()` calls `deleteWebhook` each time.
  - Production logs ≥100 `TELEGRAM_WEBHOOK_HELD` reclaims after runs of up to 51 consecutive 30-second mismatches: ≥ ~3,025 mismatched checks ≈ ≥25 h ≈ ≥15% of checks, 2026-09-20 → 09-26.
  - Update `574790448` is missing from production.
  - The current preview `startCommand` would not start the bot. The running deployment predates it, which explains why the 2026-09-03 incident "ruled it out".
- **Affected:** Telegram ingress, all users.
- **User impact:** commands silently unanswered, or answered by 23-day-old code.
- **Commercial impact:** first-touch failures; trust.
- **Root cause:** a preview service in the production environment holds the production bot token and runs in default polling mode (`config.ts:17` default `polling`; no `TELEGRAM_TRANSPORT` on preview).
- **Repair (founder action; this audit did not change it):**
  1. Remove `TELEGRAM_BOT_TOKEN` (and the signing keys) from `aria-real1-preview`, or remove its active deployment or the service.
  2. Do **not** rotate the bot token before this; the incident doc's own warning applies.
  3. Afterwards, consider a startup guard: refuse polling when `NODE_ENV=production` or `RAILWAY_ENVIRONMENT_NAME=production`.
- **Acceptance test:** 24 h of production logs with 0 `TELEGRAM_WEBHOOK_MISMATCH` and 0 `REASSERT_FAILED`; preview logs show no `telegram bot online`; `update_id` sequence contiguous.

**P0-2: The webhook secret is leaked to logs, enabling admin impersonation.**
- **Evidence:** J-1.
- **Affected:** `src/index.ts:201–205` error logging; `/api/telegram/webhook` auth; admin commands.
- **User impact:** a forged admin could revoke users, mint invites, or read lead stats.
- **Commercial impact:** trust and PII exposure.
- **Root cause:** the grammy error object (with `payload`) is logged unredacted.
- **Repair:**
  1. Redact `err.payload` and any `secret_token` in the logger (pino `redact` paths, or log only `err.error_code` and `err.description`).
  2. Deploy.
  3. Rotate `TELEGRAM_WEBHOOK_SECRET` (the reassert loop re-registers the new one within 3 s).
  4. Purge or limit old logs if Railway allows.
  5. Consider requiring a second factor for destructive admin commands.
- **Acceptance test:** a unit test proving the serialised `REASSERT_FAILED` log contains no `secret_token`; post-deploy log sample confirms; old secret rejected (forged POST with old secret returns 401/403).

## P1 — product

**P1-1: No engine in production, so no founder-independent path to first PAPER value.**
- **Evidence:** `engineSha:null`. A new user must install `aria-engine` locally, get an invite, run `/pair`, and pair.
- **Impact:** almost nobody reaches a candidate or position.
- **Repair:** land hosted PAPER (P1-2).
- **Acceptance test:** a non-founder completes `/start` → `/paper_start` → first PAPER snapshot visible, with no local install.

**P1-2: The hosted-PAPER program is fragmented and unreviewed.**
- **Evidence:**
  - `work/hosted-paper-engine-packaging` (`6901a28`) and `fix/hosted-pairing-state-seeding` / `fix/hosted-entitlement-renewal` (`570bb80` / `f9fd402`) **both fork from `aa77e8f` and diverge**: packaging is 5 commits ahead of renewal, renewal 6 ahead of packaging.
  - Renewal lacks `2e4da25` (`rev-list main...renewal` = 1/34), so merging it as-is reverts release identity.
  - Renewal's second review FAILED (uncommitted evidence); third cycle uncommitted.
  - Task 5 unreviewed; Task 6 third-review verdict unknown.
  - Railway lacks `ARIA_ENGINE_COMMIT_SHA` and an engine fetch credential.
  - The ledger's lines 9–10 still say engine `main` lacks the merged work (stale).
- **Repair:**
  1. Commit the third renewal cycle and get it independently reviewed.
  2. Integrate the seeding+renewal branch onto packaging (rebased on `main`).
  3. Run the Task 5 and Task 6 reviews.
  4. Fix the ledger header.
- **Acceptance test:** one branch containing `2e4da25`, packaging, seeding, and renewal, with all rows REVIEWED-PASS and the full suite green.

**P1-3: License email is broken for real users.**
- **Evidence:** Resend 403 testing-mode on lead 4 (2026-09-24).
- **Repair:** verify a sending domain in Resend and change `from`, or remove the email step from the promised flow.
- **Acceptance test:** a trial for a non-founder address logs a successful send.

**P1-4: Onboarding copy points to the legacy license form, not the PAPER product.**
- **Evidence:** `/start` says "Fill the form inside: name, email, Solana wallet. You'll get your license instantly." The value path is invite → local engine → `/pair`, which only the founder can explain.
- **Repair:** rewrite `/start` to state the real next step.
- **Acceptance test:** a live human test by a non-founder, without help. `UNKNOWN — requires live human Telegram test, not performed by this audit`.

## P2 — commercial

- **P2-1: Funnel not readable.** `funnel_events` exists, but no readout was found. Fix: the §H instrumentation.
- **P2-2: Error severity is lost in Railway.** `logger.error` lines appear as `severity: info`, and `@level:error` returns nothing. Alerting is blind. Fix: logger level/format mapping.
- **P2-3: No payment path or storefront.** `paymentsEnabled:false`; no Whop found. That is deliberate for the beta, but there is no monetisation path.
- **P2-4: Meta description "sniper control center".** Unsupported claim (carried forward).
- **P2-5: `CLAUDE.md` describes a paid sniper with Stripe tiers.** Documentation drift that misleads future sessions.

## P3 — improvement

- **P3-1:** flat-bps PAPER slippage with no price impact and no failed-transaction model.
- **P3-2:** default public RPC with empty fallback list.
- **P3-3:** `"emergency"` exit is an alias of `"full"`.
- **P3-4:** "Realized/Unrealized PnL" rows lack the PAPER label.
- **P3-5:** the 3 s `setWebhook` reassert loop self-inflicts 429s. Once P0-1 is fixed, relax it to detect-then-fix.

---

# M. NEW WEAK SPOTS (§21). Not in any prior audit.

1. **Config ≠ running deployment.** A service's current `startCommand` was treated as proof of what its running process does. A FAILED redeploy leaves the previous deployment serving the old command. Every "ruled out by config" conclusion must be checked against the active deployment's logs.
2. **Unsafe default transport.** `TELEGRAM_TRANSPORT` defaults to `polling` (`config.ts:17`). Any service or dev machine given the prod token without that variable becomes a competing consumer. A dev default should not be the fail-open production behaviour.
3. **Logger severity mapping.** Error events are recorded as `info`, so there are no error-based alerts. This is why a 7-day, ~15%-of-checks ingress outage went unnoticed.
4. **Secret-bearing error serialisation.** Any library error that echoes request payloads (grammy, Stripe, Resend) is a secret-leak vector. There is no logger `redact` configuration.
5. **Signing-key sprawl.** Entitlement and licence private keys are copied onto a non-`main` preview service. No inventory exists of where keys live.
6. **Update-loss invisibility.** No `update_id` gap detection; lost updates are silent. Found here only by manual sequence inspection (`448`).
7. **Evidence recorded only in uncommitted comments.** A second review FAIL exists only in uncommitted comments. The committed ledger still says "awaiting review", so a reader of `origin` would be misled.
8. **Branch-topology debt.** The P0 fix branches for hosted PAPER do not contain the packaging branch, and none contain `2e4da25`. Merging in the wrong order silently drops work.
9. **Tests that cannot fail.** The renewal D2 test passed with the logic under test deleted, according to a reviewer's finding quoted in the diff. That is the same vacuous-test class as Task 6's first failure, and it now recurs across programs.
10. **Resend testing mode in production.** A dependency's sandbox mode silently limits the product to one recipient.

---

# N. COMMERCIAL READINESS (§18). Separate assessments, no score.

| Question | Answer | Evidence | Limitation |
|---|---|---|---|
| Can ARIA be demonstrated? | **Partially.** The bot and Mini App are live. A PAPER demo requires the founder's machine running the engine | `/healthz`; engine local-only | Demos can fail at random (P0-1) |
| Privately beta-tested? | **Yes, with founder hand-holding.** Invite system live; 3 non-founder starts in 7 d | §H | ~15%+ of ingress checks hijacked; email broken |
| Used repeatedly? | NOT MEASURABLE | no sync/return telemetry read | — |
| Onboarded without founder assistance? | **No** | P1-1, P1-4 | live human test not performed |
| Monetized? | **No.** $0; payments disabled | `paymentsEnabled:false` | — |
| Sold as access to software? | **No.** No checkout, no storefront found | §I | — |
| Offered for acquisition? | **Only as code/IP.** Substantial reviewed engineering (engine 1,368 assertions; LIVE M1 design), but no users, revenue, or hosted product | §F, §H | open P0 security findings would surface in diligence |
| Operated safely at increased usage? | **No.** Ingress is unreliable, admin auth is compromised by the log leak, and hosted PAPER is capped at 5 concurrent tenants by design | §L | — |

---

# O. NEXT 24 HOURS (§25)

## MUST DO

**1. Stop the preview service from consuming the production bot (P0-1).**
- **Problem:** `aria-real1-preview` long-polls with the prod token and deletes the prod webhook.
- **Why now:** every hour costs real user updates, and the preview answers with 23-day-old code.
- **Action (founder, in the Railway dashboard):** remove `TELEGRAM_BOT_TOKEN` from `aria-real1-preview`, or remove its active deployment `9bf591be` or the service. While there, remove `ARIA_ENTITLEMENT_PRIVATE_D` and `ARIA_LICENSE_PRIVATE_D` from it. Do not rotate the bot token.
- **Files/services affected:** Railway service `35aaf768-…` only.
- **Acceptance criterion:** preview logs show no `telegram bot online`.
- **Production verification:** 24 h of prod logs with 0 `TELEGRAM_WEBHOOK_MISMATCH`, and `update_id`s contiguous.

**2. Stop logging the webhook secret, deploy, then rotate it (P0-2).**
- **Problem:** plaintext `secret_token` in the logs.
- **Why now:** it is the only authentication for inbound updates, and admin commands trust `from.id`.
- **Action:** in `src/index.ts`, log `{ code: err.error_code, description: err.description }` instead of `{ err }` for `REASSERT_FAILED` and similar; add a pino `redact` for `*.payload`, `*.secret_token`, `*.headers.authorization`. Add a test asserting no `secret_token` in the serialised log. PR, review, merge, deploy. Then rotate `TELEGRAM_WEBHOOK_SECRET` in Railway.
- **Files/services affected:** `src/index.ts`, `src/logger*.ts` (or wherever pino is built), new test; Railway prod var.
- **Acceptance criterion:** the test passes; `/healthz` SHA equals the new commit.
- **Production verification:** filtered prod logs contain no `secret_token`; a POST with the old secret is rejected.

**3. Make errors visible (P2-2, a prerequisite for verifying 1 and 2).**
- **Problem:** `@level:error` returns nothing.
- **Why now:** without it, fixes 1 and 2 cannot be monitored.
- **Action:** fix the logger level serialisation so Railway sees `severity:error` (for example, emit `level` as a label or configure pino formatters).
- **Files/services affected:** logger module.
- **Acceptance criterion:** a forced test error appears under `@level:error`.
- **Production verification:** the Railway `@level:error` filter returns real error lines post-deploy.

**4. Record the renewal fix's true state (P1-2 hygiene).**
- **Problem:** the committed ledger says "awaiting review", but a second review failed.
- **Why now:** it prevents a false "done" from propagating.
- **Action:** commit the uncommitted third cycle in `aria-telegram-BOT-APP-hosted-impl` together with a ledger entry recording the second-review FAIL (Defects 1 and 2), then request the third independent review. Also correct ledger lines 9–10.
- **Files/services affected:** `src/fleet/hosted-pairing-seed.ts`, its test, and the LEDGER on `fix/hosted-entitlement-renewal`.
- **Acceptance criterion:** the ledger row matches the reviewer outcome; the review is run with the revert-and-confirm-fails check on D2.
- **Production verification:** none (branch-only).

## SHOULD DO

1. Fix the Resend sending domain so non-founder trial emails deliver (P1-3).
2. Add `update_id` gap logging and a daily `getFunnelCounts()` log line (§H instrumentation).
3. Change the `TELEGRAM_TRANSPORT` default to fail closed in production: refuse polling when `RAILWAY_ENVIRONMENT_NAME=production` (§M-2).
4. Plan the hosted-PAPER branch integration order in writing: `main` → packaging → seeding → renewal, rebased so `2e4da25` is kept (P1-2).
5. Correct `ARIA_PRODUCT_SCALE_STATE.md`'s conflict-incident section with this root cause, once P0-1 is confirmed fixed.

## LATER (deliberately deferred)

- Merging or deploying hosted PAPER, which is blocked on the P1-2 reviews.
- The LIVE Vertical Slice (any milestone).
- PAPER realism upgrades (price impact, failed-transaction modelling), paid RPC, and Whop/Stripe enablement.
- `/start` copy rewrite, which should wait until a delivery-reliable baseline exists so it can be user-tested.
- The meta-description and PnL-label cosmetics.

---

# P. FOUNDER EXECUTION CARD

**Status**

| Area | Status |
|---|---|
| Production | UP, `2e4da25`, 7.2 d uptime, unchanged since 2026-09-19 |
| Telegram | **DEGRADED**: webhook hijacked in ≥15% of checks; ≥1 update lost |
| Solana data | not in production (local engine only; public RPC) |
| Candidate engine | not in production (local only; tests green) |
| Paper execution | not in production (local only; simulated fills) |
| Live execution | not implemented (no transaction construction anywhere) |

**Numbers**

| Measure | Value |
|---|---|
| Users | 3 non-founder Telegram IDs sent updates in 7 d (lower bound); activated or repeat users NOT MEASURABLE |
| Paid users | 0 |
| Revenue | $0 |

**Critical blocker.** A stale 23-day-old `aria-real1-preview` Railway service is long-polling with the production bot token, stealing real users' Telegram updates. That same failing loop leaks the production webhook secret into the logs, which opens a path to forged admin commands.

**Most important weak spot.** Production error logs are recorded as `info`, so a week-long ingress outage and a secret leak raised no alert.

**Most important progress since last audit.** No code shipped. The long-"unidentified" second Telegram poller (open since 2026-09-03) is now positively identified by log evidence as ARIA's own preview service.

**Next production milestone.** 24 consecutive hours with zero webhook mismatches, no secret in logs, a rotated webhook secret, and contiguous `update_id`s. That gives an authenticated, reliable Telegram front door.

**Today:**
1. In Railway, remove `TELEGRAM_BOT_TOKEN` and both private keys from `aria-real1-preview` (or stop its deployment). Do not rotate the bot token.
2. Ship the log-redaction fix, then rotate `TELEGRAM_WEBHOOK_SECRET`.
3. Fix logger severity so `@level:error` works, and watch 24 h of logs.

**Do not work on today:** hosted-PAPER merge or deploy; LIVE Vertical Slice; new engine features or research-derived models; payments or storefront; `/start` copy or UI polish; bot-token rotation.
