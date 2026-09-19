# ARIA Production Convergence — ground-truth reconciliation

**Generated:** 2026-09-19
**Method:** every value below was re-derived this session from `git fetch origin --prune`
on both repos' real remotes, from the **live** `/healthz` JSON response, and from the
Railway MCP API. Nothing was carried over from a prior conversation, a prior document,
or a remembered SHA.

---

## THE RULE THIS DOCUMENT ENFORCES

> **Merged is not deployed. Deployed is not verified. Verified is not user-visible.
> Nothing in this document may be called "production" because it is merged.**

A commit on a repo's `main` is merged. A Railway deployment marked `SUCCESS` is
deployed. Only an observed response from the live service, or an observed log line
from the running process, is *runtime verified*. Each of those is a separate column
below and they are never collapsed.

Two corollaries that apply specifically to this system:

1. **`aria-engine` is not a Railway service.** It has no deployment of its own.
   Merging something to `aria-engine`'s `main` changes what a *future* control-plane
   image could package — it does not put a single line of that code into production.
   Everything on `aria-engine` `main` is therefore `MERGED_NOT_DEPLOYED` at best.
2. **A green `/healthz` proves the control plane is alive and proves nothing about
   the engine.** The live response says so itself: `release.engineSha` is `null`.

---

## Part 1 — exact SHA reconciliation

All git values from `git -C <repo> fetch origin --prune` followed by
`git rev-parse origin/<branch>`, run 2026-09-19.

| Name | Value | How obtained |
|---|---|---|
| `CONTROL_PLANE_MAIN_SHA` | `2e4da2526a2ed0a565641eca9efd2854d7cb83b7` | `git -C aria-telegram-BOT-APP rev-parse origin/main` |
| `HOSTED_BRANCH_SHA` | `aa77e8fc2bc31d9560a9344c9d9aba137b8c6dbe` | `git rev-parse origin/work/hosted-paper-engine-impl` |
| `PACKAGING_BRANCH_SHA` | `6901a28697e0b0fe55b28f0ed42e2e11e54a85a9` | `git rev-parse origin/work/hosted-paper-engine-packaging` |
| `LIVE_MILESTONE1_BRANCH_SHA` | `cb94f9acbb96a9b7e82cd748fca5fd2b7d3e98e7` | `git rev-parse origin/impl/live-vertical-slice-0.1-milestone-1` |
| `LIVE_SPEC_SHA` | `8c99ba367ebfe6258916b030a426fc09704d7c92` | `git rev-parse origin/plan/live-vertical-slice-0.1` |
| `ENGINE_MAIN_SHA` | `766dcdbc7aca1dad54d6294729fba1f45a8b6481` | `git -C aria-engine rev-parse origin/main` |
| `RAILWAY_DEPLOYED_SHA` | `2e4da2526a2ed0a565641eca9efd2854d7cb83b7` | live `curl https://aria-telegram-bot-app-production.up.railway.app/healthz` → `release.controlPlaneSha` |
| `RAILWAY_ENGINE_SHA` | **`null`** | same live response → `release.engineSha` |

Full live `/healthz` body as returned:

```json
{"ok":true,"uptime":16575.660242214,"leads":3,"paymentsEnabled":false,
 "release":{"controlPlaneSha":"2e4da2526a2ed0a565641eca9efd2854d7cb83b7",
 "branch":"main","buildTime":"2026-09-19T19:05:34Z",
 "releaseId":"2e4da2526a2e@2026-09-19T19:05:34Z","mode":"paper","engineSha":null}}
```

### Railway cross-check

Railway MCP `list-deployments`, project `bubbly-prosperity`
(`4f5fba5b-a1ab-4240-b5a6-0ded65caf113`), service `aria-telegram-BOT-APP`
(`dddae878-b35d-4f0f-8140-dfda6e8e33b7`), environment `production`
(`fe8a169d-f44d-4e8a-bf5b-8bcad00574be`):

- Latest deployment `4025dcce-c067-41d0-8083-bc6ad5c2b93d`, status `SUCCESS`,
  created `2026-09-19T19:05:09Z`, `meta.commitHash = 2e4da2526a2ed0a565641eca9efd2854d7cb83b7`,
  `meta.branch = main`.
- **No gap.** `CONTROL_PLANE_MAIN_SHA` == Railway deployed commit == live
  `/healthz release.controlPlaneSha`. The three-link chain agrees exactly.
- The domain `aria-telegram-bot-app-production.up.railway.app` was confirmed to
  belong to this service via `list-domains` — it was not assumed.
- **Three links agree; the fourth does not exist.** There is no engine link:
  `list-variables` on this service returns 37 variable names and
  `ARIA_ENGINE_COMMIT_SHA` is **not among them**, matching `engineSha: null`.

### Ahead/behind (`git rev-list --left-right --count origin/main...origin/<branch>`)

Left = commits on `origin/main` that the branch lacks. Right = commits on the branch
that `main` lacks.

| Branch | main-only | branch-only | Merged into main? |
|---|---|---|---|
| `work/hosted-paper-engine-impl` | 1 | 28 | NO (`git merge-base --is-ancestor` → false) |
| `work/hosted-paper-engine-packaging` | 0 | 32 | NO — but a strict **superset** of `main` (0 main-only), so it already contains the release-identity commit |
| `impl/live-vertical-slice-0.1-milestone-1` | 1 | 4 | NO |
| `plan/live-vertical-slice-0.1` | 1 | 1 | NO |
| `chore/release-identity-and-manifest` | 0 | 0 | **YES** — identical to `main`; this is the work that shipped as `2e4da25` |

The single "main-only" commit that three branches lack is `2e4da25` itself
(the build-identity `/healthz` block). Both LIVE branches therefore *delete*
`docs/ARIA_PRODUCTION_RELEASE_MANIFEST.md`, `src/release.ts` and
`test/release-identity.ts` relative to `main` — an artefact of branch age, not an
intentional removal. Whoever merges them must rebase first or that work is lost.

### `aria-engine` branch reconciliation — a stale claim corrected

| Branch | main-only | branch-only |
|---|---|---|
| `work/reference-driven-commercialization-impl` | 4 | 0 (fully merged) |
| `feat/hosted-runtime-dir-override` | 39 | 0 (fully merged) |

`aria-engine` `main` @ `766dcdb` is `Merge feat/hosted-runtime-dir-override into main`,
sitting on top of `9e4d7b0 Merge reference-driven-commercialization-impl into main`.

**This contradicts the hosted-engine ledger.** `docs/superpowers/plans/2026-09-08-hosted-engine-LEDGER.md`
lines 9–10 state that both the commercialization program *and* `feat/hosted-runtime-dir-override`
are "NOT yet merged to aria-engine's `main`", and instruct Task 2+ to spawn processes off the
unmerged branch. Both have since been merged. **That ledger text is stale as of 2026-09-19** and
should be corrected before anyone acts on its spawn instructions. Verified directly:
`git grep ARIA_RUNTIME_DIR origin/main -- src` returns `src/runtime/paths.ts:40` and
`src/runtime/paths.test.ts` on `main`.

---

## Part 2 — component-by-component convergence

"Merged?" means merged to **that repo's own `main`**. For `aria-engine` rows,
a `YES` in that column carries **no deployment implication whatsoever** —
`aria-engine` is not a Railway service.

| Component | Current SHA | Canonical? | Tested? | Reviewed? | Merged? | Deployed? | Runtime verified? | User visible? | Commercial value? |
|---|---|---|---|---|---|---|---|---|---|
| **Control-plane `main`** | `2e4da25` | YES — the one deployable trunk | YES — `npm test`: `e2e.ts`, `engine-customer-api-contract.ts`, `frontend-reality.ts`, `real1-truthfulness.ts`, `billing-lifecycle.ts`, `release-identity.ts` | Shipped per-item, verified-live per commit trail (`f2e1ffd` "all 20 items closed, verified live") | YES (is `main`) | YES — Railway `4025dcce` SUCCESS | YES — live `/healthz` 200 + `TELEGRAM_WEBHOOK_OK` every 30s in prod deploy logs | YES — bot + Mini App at `PUBLIC_URL` | Indirect — free PAPER BETA tier; `paymentsEnabled:false` in live `/healthz` |
| **Hosted-engine branch** `work/hosted-paper-engine-impl` | `aa77e8f` | NO — superseded by the packaging branch (strict superset) | YES in-branch (`fleet-manager.test.ts` 65/65 per ledger Task 3) | Tasks 1–4 REVIEWED-PASS/FIXED; Task 5 awaiting; Task 6 FAILED×2, third review pending | **NO** | NO — no `src/fleet/` exists on `main` | NO | NO | NO |
| **Packaging branch** `work/hosted-paper-engine-packaging` | `6901a28` | YES — the live head of the hosted program | YES (inherits + `scripts/packaged-engine-integration-test.mts`) | Task 7 REVIEWED-FIXED (PASS w/ 3 minor defects D1–D3, all fixed) | **NO** | NO | NO | NO | NO — blocked: `ARIA_ENGINE_COMMIT_SHA` + fetch credential absent from Railway vars (Task 7's own named operational blocker, re-confirmed today) |
| **LIVE Milestone 1** `impl/live-vertical-slice-0.1-milestone-1` | `cb94f9a` | YES for the LIVE program | YES — 6 new suites; ledger: 244 new checks, `npm test` 368 total after review-round-1 fixes; `test/live-schema-contract.ts` (32) run against real Postgres 17.6 | **YES** — ledger header: `INDEPENDENT REVIEW PASS (round 2, post-fix)` | **NO** | NO | NO | NO | NO — `LIVE_ENABLED` defaults closed; empty founder allowlist admits nobody |
| **LIVE spec** `plan/live-vertical-slice-0.1` | `8c99ba3` | YES — `docs/SPEC-LIVE-VERTICAL-SLICE-0.1.md` (1848 lines) + `docs/proposed-002_trading_accounts.sql` | N/A (document) | Implicitly, by Milestone 1's passing review against it | **NO** | N/A | N/A | NO | NO (planning artefact) |
| **Engine `main` — commercialization** | `766dcdb` (merge `9e4d7b0`) | YES | YES — full suite per ledger; Tasks 6–9 each closed DONE/REVIEWED-PASS (`79f0e0a`, `b212814`, `9774eaa`, `0e311b9`) | YES | **YES (aria-engine main)** | **NO — and merging here is not a deploy: aria-engine has no Railway service** | NO | NO | NO until a control-plane image packages it |
| **Engine `main` — `ARIA_RUNTIME_DIR`** | `766dcdb` (merge of `69299df`) | YES | YES — `src/runtime/paths.test.ts`, spawns real subprocesses, asserts all 9 path constants relocate and the no-override defaults are byte-identical | YES — Task 1 REVIEWED-PASS (reviewer traced all 9 constants incl. the lock file) | **YES (aria-engine main)** | **NO — same caveat** | NO | NO | NO |
| **Build-identity `/healthz`** | `2e4da25` | YES | YES — `test/release-identity.ts` (real values present / explicit `"unknown"` fallback in a clean child process / no env leakage) | Shipped on `main` via `chore/release-identity-and-manifest` (0/0 vs `main`) | **YES** | **YES** | **YES** — live response carries real `controlPlaneSha`/`buildTime`/`releaseId` matching the Railway deployment | NO (ops surface) | Indirect — it is the instrument that makes every other row in this table checkable |

**Headline row count by status:** 8 components —
**2** are deployed and runtime-verified (control-plane `main`, build-identity `/healthz`);
**2** are merged to `aria-engine` `main` but have **no** deployment path today
(commercialization, `ARIA_RUNTIME_DIR`);
**4** are unmerged branches (hosted impl, packaging, LIVE Milestone 1, LIVE spec).
**0** components are both merged to the control plane and awaiting deploy —
the control-plane trunk and production are exactly in sync.

---

## Part 3 — full capability inventory

Classification set: `PRODUCTION_VERIFIED`, `DEPLOYED_UNVERIFIED`, `MERGED_NOT_DEPLOYED`,
`IMPLEMENTED_REVIEWED`, `IMPLEMENTED_UNREVIEWED`, `PARTIAL`, `MISSING`, `SUPERSEDED`.

- `PRODUCTION_VERIFIED` requires an observation from the live service or its running
  process this session.
- `DEPLOYED_UNVERIFIED` means the code is provably in the deployed image
  (`2e4da25`) but no runtime evidence was collected.
- `MERGED_NOT_DEPLOYED` is the correct ceiling for everything on `aria-engine` `main`.

### TELEGRAM / CONTROL PLANE — all at `2e4da25`, i.e. in the running image

| Capability | Status | Evidence |
|---|---|---|
| bot | `PRODUCTION_VERIFIED` | `src/bot.ts` (16 `bot.command(...)` handlers); Railway `4025dcce` SUCCESS; webhook delivering with `pendingUpdateCount: 0` |
| webhook transport | `PRODUCTION_VERIFIED` | `src/index.ts:100` `TELEGRAM_TRANSPORT === "webhook"`; Railway var `TELEGRAM_TRANSPORT` + `TELEGRAM_WEBHOOK_SECRET` set |
| webhook self-healing | `PRODUCTION_VERIFIED` | `src/index.ts:171–203` (unconditional `setWebhook` every cycle, no detect-first step); prod deploy logs show `TELEGRAM_WEBHOOK_OK` at a steady 30 s cadence from 23:16:06Z through 23:46:12Z |
| Telegram auth | `DEPLOYED_UNVERIFIED` | `src/telegram-auth.ts`; `src/server.ts:164` `POST /api/auth/telegram` |
| Mini App | `DEPLOYED_UNVERIFIED` | `public/index.html` + `public/app.js`; served by `src/server.ts:678` catch-all |
| invite gate | `DEPLOYED_UNVERIFIED` | `src/invites.ts`; `src/bot.ts:337,348`; migration `1757000000000_create-invites.js` |
| pairing fallback | `DEPLOYED_UNVERIFIED` | `src/bot.ts:207` `/pair`; `src/server.ts:211` `/api/engine/pairing-code`, `:262` `/api/engine/pair`; `public/index.html:163` CREATE PAIRING CODE |
| status | `DEPLOYED_UNVERIFIED` | `src/bot.ts:169,171` → `replyWithLicenseStatus` |
| onboarding | `DEPLOYED_UNVERIFIED` | `public/index.html:79` "Getting started" + `onboarding-count` |
| recovery states | `DEPLOYED_UNVERIFIED` | `public/index.html:178` `recovery-copy-doctor-btn`; commit `612a1aa` "structured recovery states" |
| notifications | `DEPLOYED_UNVERIFIED` | `src/bot.ts:263` `/notifications`; `src/engine-offline-alerts.ts`; migration `1757300000000_add-engine-offline-alerts.js` |
| support | `DEPLOYED_UNVERIFIED` | `src/bot.ts:242` |
| feedback | `DEPLOYED_UNVERIFIED` | `src/feedback.ts`; `src/bot.ts:400`; `src/server.ts:633`; migration `1757200000000_create-feedback.js` |
| attribution | `DEPLOYED_UNVERIFIED` | `src/bot.ts:391` |
| LIVE interest capture | `DEPLOYED_UNVERIFIED` | `src/server.ts:592` `POST /api/interest`, `kind: z.enum(["live","paid"])` → `trackEvent("live_interest_clicked")` |
| paid interest capture | `DEPLOYED_UNVERIFIED` | same route, `"paid"` branch; `public/index.html:214` "NOTIFY ME WHEN AVAILABLE" |
| funnel telemetry | `DEPLOYED_UNVERIFIED` | `src/funnel.ts` (`FunnelEvent`, `trackEvent`, `getFunnelCounts`); migration `1757100000000_create-funnel-events.js` |
| version enforcement | `DEPLOYED_UNVERIFIED` | `src/config.ts:154–155` `RECOMMENDED_ENGINE_VERSION`/`MINIMUM_SUPPORTED_ENGINE_VERSION` both `0.7.0-beta.4`; `src/engine-customer-routes.ts:15–17` dual-tier comparator |
| engine-disconnected state | `DEPLOYED_UNVERIFIED` | `src/engine-offline-alerts.ts` (10-min stale `last_seen_at`); `public/index.html:115,117` "WAITING FOR ENGINE" / "engine unavailable" |

### ENGINE / MARKET INTELLIGENCE — all at `aria-engine` `766dcdb`

Every row is `MERGED_NOT_DEPLOYED`: merged to `aria-engine` `main`, and `aria-engine`
has no Railway service, so none of it runs in production.

| Capability | Status | Evidence |
|---|---|---|
| Pump discovery | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-decoder.ts`; registered `src/cli.ts:364` |
| Pump create decoding | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-decoder.ts` + `pump-decoder.test.ts` |
| PumpSwap migration | `MERGED_NOT_DEPLOYED` | `src/discovery/pumpswap-decoder.ts`; `src/cli.ts:364` |
| Raydium discovery | `MERGED_NOT_DEPLOYED` | three decoders — `raydium-launchpad-decoder.ts`, `raydium-cpmm-decoder.ts`, `raydium-clmm-decoder.ts`; all three at `src/cli.ts:364` |
| Meteora discovery | `MERGED_NOT_DEPLOYED` — **genuinely present, not scaffolded** | `src/discovery/meteora-dbc-decoder.ts` (104 lines, both DBC discriminators, layout taken from Meteora's own IDL `release_0.1.6.json`), own test file `meteora-dbc-decoder.test.ts` (73 lines), imported `src/cli.ts:37` and **registered in the real discovery path** at `src/cli.ts:364` alongside the five other decoders, whose program IDs feed `PollingRpcTransport` at `:365` and `DiscoveryEngine` at `:366`. This was checked specifically because the task flagged it as suspect — it is real wiring, not a stub. |
| bonding curve state | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-curve-state.ts` |
| curve-native pricing | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-curve-pricing.ts`; consumed by `src/market/discovery-market-source.ts` |
| dynamic Pump fee resolution | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-fee-config.ts`, `src/discovery/pump-fee-resolver.ts` |
| cross-source price reconciliation | `MERGED_NOT_DEPLOYED` | `src/market/observation-pipeline.ts`, `src/market/real-market-source.ts`, `src/safety/price-source-agreement-check.ts` (+ `jupiter-price-source.ts`, `raydium-price-source.ts`) |
| candidate dedup | `MERGED_NOT_DEPLOYED` | `src/discovery/candidate-deduplicator.ts`, `src/discovery/candidate-id.ts` |
| safety evaluators | `MERGED_NOT_DEPLOYED` | `src/safety/` — 12 checks (mint-authority, freeze-authority, holder-concentration, liquidity, creator-history, creator-funding, duplicate-mint, social-presence, sellability, metadata-mutability, price-source-agreement, staleness) behind `evaluate-candidate.ts` |
| FOMO / momentum | `MERGED_NOT_DEPLOYED` | `src/discovery/pump-fomo-engine.ts` (+ `rpc-transaction-stream-provider.ts`) |
| eligibility | `MERGED_NOT_DEPLOYED` | `src/strategy/candidate-eligibility.ts` |

### PAPER EXECUTION — `aria-engine` `766dcdb`

| Capability | Status | Evidence |
|---|---|---|
| PAPER fills | `MERGED_NOT_DEPLOYED` | `src/paper/paper-fill.ts` |
| positions | `MERGED_NOT_DEPLOYED` | `src/paper/paper-position.ts` |
| PnL | `MERGED_NOT_DEPLOYED` (engine side) | `src/paper/paper-accounting.ts`. Note the **display** half *is* deployed — `public/app.js:270,388` render `realizedPnlLamports`/`unrealizedPnlLamports` from a synced snapshot — but with no engine there is no snapshot to render. |
| fees | `MERGED_NOT_DEPLOYED` | `src/paper/paper-config.ts`, `src/paper/execution-cost-model.ts` |
| Jito PAPER cost model | `MERGED_NOT_DEPLOYED` | `src/paper/jito-paper-model.ts` + test |
| execution-cost envelope | `MERGED_NOT_DEPLOYED` | `src/paper/execution-cost-model.ts`; commit `03845d2` (Task 7), closed REVIEWED-PASS at `b212814` |
| progressive exits | `MERGED_NOT_DEPLOYED` | `src/paper/paper-progressive-exit.ts` `buildExitPlan("progressive", fractionsBps)`; wired into `npm test` at `56990a2` |
| trailing exits | `MERGED_NOT_DEPLOYED` | `src/paper/paper-position.ts:105–162` — monotonic watermark, priority `take-profit > stop-loss > trailing-stop > max-age`, `trailingStopBps: 0` = disabled |
| partial exits | `MERGED_NOT_DEPLOYED` | `src/paper/paper-progressive-exit.ts:20` `ExitTranche.fractionBps`, explicitly a fraction of the ORIGINAL quantity (docblock lines 10–15 reason about why "fraction of remaining" would under-close) |
| emergency exits | **`PARTIAL`** | `buildExitPlan` accepts `"emergency"` (`paper-progressive-exit.ts:45`) but `:46` routes `"full" \|\| "emergency"` to the identical single-100%-tranche plan. The docblock (`:30–41`) states this is deliberate — the mode carries **no urgency semantics, no distinct exit reason, no separate slippage/cost path**. It is an accepted enum value, not a distinct behaviour. |
| journal | `MERGED_NOT_DEPLOYED` | `src/runtime/event-journal.ts`, `journal-events.ts`, `trading-journal.ts`; Task 8 commit `052d795`, closed REVIEWED-PASS `9774eaa` |
| replay | `MERGED_NOT_DEPLOYED` | `src/runtime/replay.ts` + `replay.test.ts` |
| restart recovery | `MERGED_NOT_DEPLOYED` | `src/runtime/paper-loop.ts:29` `createOrRestoreEngine(config, clock, idGenerator, snapshotPath = PAPER_SNAPSHOT_PATH)` |
| audit-paper | `MERGED_NOT_DEPLOYED` | `src/runtime/commercial-paper-audit.ts`; Task 9 commit `8656b81`, review fix `5429a04`, closed DONE/REVIEWED-PASS `0e311b9` |
| commercial PAPER certification tooling | `MERGED_NOT_DEPLOYED` | same module (the audit command *is* the certification tool); `commercial-paper-audit.test.ts` |

### HOSTED INFRASTRUCTURE — `work/hosted-paper-engine-packaging` @ `6901a28` unless noted

Verdicts taken from `docs/superpowers/plans/2026-09-08-hosted-engine-LEDGER.md`,
not inferred.

| Capability | Status | Evidence |
|---|---|---|
| FleetManager | `IMPLEMENTED_REVIEWED` | `src/fleet/fleet-manager.ts`; ledger Task 2 DONE — REVIEWED-PASS after 1 fix cycle (`fdb4796` + `e7c0d4c`); reviewer found and reproduced a real P0 resurrection race in `stopTenant()`, fix verified by running the new regression test against the pre-fix file |
| shared-FleetManager topology (vs rejected per-tenant-instance) | `IMPLEMENTED_UNREVIEWED` | **The code today uses ONE SHARED instance.** `scripts/fleet-soak.ts:382` constructs a single `new FleetManager({...maxConcurrentTenants: N})` for the whole main soak; comments at `:364–379` record that the per-tenant-instance topology introduced by fix `1123008` was rejected and reverted because it made the in-memory isolation channel structurally unable to detect the bug class the test exists to catch. Production wiring matches: `src/fleet/instance.ts:36` exports one module-level `fleetManager` singleton. Second re-certification fix `ed1db8c` has **not** yet had its independent review. |
| tenant processes | `IMPLEMENTED_REVIEWED` | `src/fleet/tenant-process.ts` (spawn, per-tenant log file, ready-marker); Task 2 |
| `ARIA_RUNTIME_DIR` | `MERGED_NOT_DEPLOYED` | `aria-engine` `main` `src/runtime/paths.ts:40`; Task 1 REVIEWED-PASS. Merged to engine `main` — **not** deployed, because no engine ships in the production image |
| tenant identity | `IMPLEMENTED_REVIEWED` | `src/fleet/hosted-device-identity.ts` — real Ed25519 keypair, written to `<runtimeDir>/state/device-identity.json` mode `0600` (`:82–84`) before spawn; Task 4 REVIEWED-FIXED after 2 fix cycles, then independently re-reviewed a third time (write-before-commit ordering, atomic `rotateClientDeviceIdentityAndSetHosted`, 90/90 tests) |
| resource bounds | `IMPLEMENTED_REVIEWED` | Task 3 `733c24e`, REVIEWED-PASS. Honest finding recorded, not fabricated: **no OS-level per-process cap is available** on Docker-on-Railway; the real defence is a concurrency cap (`maxConcurrentTenants`, default 5) plus crash-loop containment — `docs/FLEET_MANAGER_RUNBOOK.md` §1 |
| crash-loop protection | `IMPLEMENTED_REVIEWED` | Task 3 — exponential backoff 5s/10s/20s/40s capped at 300 000 ms, give-up at 5 consecutive crashes → terminal `failed`, 60 s sustained-healthy reset; reviewer hand-traced all 5 crash counts |
| SIGKILL recovery | `IMPLEMENTED_REVIEWED` | `src/fleet/fleet-manager.test.ts` isolation block: external `process.kill(victimPid,"SIGKILL")` bypassing `stopTenant`, then asserts victim reaches `crashed` and recovers via the ordinary backoff path |
| process cleanup | `IMPLEMENTED_REVIEWED` | `stopTenant()` desired-state → wait → `SIGTERM` (4 s) → `SIGKILL`, awaited unconditionally; Task 2 P0 fix `e7c0d4c` also cancels a pending `restartTimer` |
| local/hosted coexistence | `IMPLEMENTED_UNREVIEWED` | `src/fleet/dual-mode-coexistence.test.ts`; ledger Task 5 status is literally `IMPLEMENTED (awaiting review)`, commit `e874097`, **reviewer verdict column empty** |
| start / status / stop commands | `IMPLEMENTED_REVIEWED` | `src/fleet/hosted-commands.ts` → `/paper_start`, `/paper_stop`, `/paper_status`; Task 4. **Not on `main`:** `grep -c paper_start src/bot.ts` on `2e4da25` returns `0` |
| isolation | `PARTIAL` | Unit-level isolation is reviewed and real (Task 2: OS-level `process.kill(pid,0)` liveness check on the survivor, byte-identical survivor log, plus a log cross-contamination test). **Soak-level isolation is not certified** — Task 6 FAILED twice and its third review is outstanding, so the end-to-end claim is unproven. |
| engine packaging (pinned-SHA Docker) | `IMPLEMENTED_REVIEWED` | `Dockerfile` stage 1 `FROM node:22-slim AS engine`, `ARG ARIA_ENGINE_COMMIT_SHA` with **no default** (fail-closed, `:30–35`), `scripts/package-engine.mjs` deletes `.git` and the token-bearing dir; Task 7 REVIEWED-FIXED, defects D1–D3 fixed in `86dee0f` |
| engine-identity verification gate | `IMPLEMENTED_REVIEWED` | `src/fleet/engine-identity.ts` — two independent sources (`ARIA_ENGINE_COMMIT_SHA` env vs `<engineRepoPath>/.engine-sha` file), fail-closed at build / `/healthz` / `spawnTenant`, refuses an unpinned engine under `NODE_ENV=production`; Task 7 |
| pairing-state seeding for hosted tenants | **`MISSING` — re-verified today, not carried over** | Re-checked from source rather than citing the prior finding. `grep -rn "pairing-state.json\|pairingState\|savePairingState" src/` on the packaging branch returns **one hit, an unrelated comment** in `src/engine-sync-desync-repro.ts:21`. The only file the fleet writes into a tenant runtime dir is `state/device-identity.json` (`hosted-device-identity.ts:84`). `aria-engine` writes pairing state separately via `savePairingState()` (`src/pairing-state.ts:51`), and `src/cli.ts:453–454` does `const pairing = loadPairingState(); if (!pairing) fail("Device is not paired. Run \`aria pair <CODE>\` first.")`. A hosted tenant therefore still starts with an identity but **no pairing state**, and `aria paper start` exits non-zero immediately. This is corroborated by the fleet's own integration test, which asserts exactly that outcome: `fleet-manager.integration.test.ts:121` checks the tenant log contains `"not paired"`. **Still missing. This is the P0 blocking hosted PAPER from ever reaching `running`.** |

### LIVE FUTURE — `impl/live-vertical-slice-0.1-milestone-1` @ `cb94f9a`

| Capability | Status | Evidence |
|---|---|---|
| TradingAccount | `IMPLEMENTED_REVIEWED` | `src/live/trading-account.ts` (`deriveAccountState`, re-derives on every transition request so ARM is never granted because the UI asked); `test/live-trading-account.ts` 57 checks; ledger: `INDEPENDENT REVIEW PASS (round 2, post-fix)` |
| wallet connection | `PARTIAL` | `src/live/wallet-ownership.ts` verifies Ed25519 ownership proofs over a **server-issued** challenge (base64 or base58), and migration `1758250000000` binds proofs to `account_id`. There is **no wallet-connect UI, no adapter, no client** anywhere in either repo — server-side verification only. |
| TradeIntent | `IMPLEMENTED_REVIEWED` | `src/live/trade-intent.ts` (`INTENT_TRANSITIONS`, `computeIdempotencyKey`, strict Zod proposal schema); `test/live-trade-intent.ts` 42 checks incl. "SUBMITTED ≠ success", "CONFIRMED ≠ position" |
| firewall | `IMPLEMENTED_REVIEWED` | `src/live/transaction-firewall.ts` — 22 declarative gates F0–F21, `UNCERTAIN = REJECT` on every gate, `recordFirewallDecision()` audits every decision; `test/live-firewall.ts` 63 checks, each rejection code read back out of the audit log |
| route builder | `MISSING` | No module. Milestone 1 is scoped "backend only, no signing/submission"; the `src/live/` tree on `cb94f9a` contains exactly 6 files, none of them a router |
| signing | `MISSING` | Same. `docs/ARIA_PRODUCTION_RELEASE_MANIFEST.md` (on `main`) records the one `signTransaction` stub in the tree as test-only, predating both branches, unimported by production code |
| submission | `MISSING` | Same |
| reconciliation | `PARTIAL` | `RECONCILED` exists as an intent state with `reconciled_at` guarded by a CHECK constraint (migration `1758240000000`), and the transition is in `INTENT_TRANSITIONS` — but **no reconciler runs**; nothing can legitimately drive an intent into that state without submission |
| LIVE position | `PARTIAL` | `live_positions` table is created by migration `1758240000000` and covered by `test/live-schema-contract.ts` against real Postgres — **schema only, no runtime code** |
| LIVE PnL | `MISSING` | No module. `src/live/money.ts` supplies the quoted-vs-realized boundary (`realizedLamports()` cannot be called without landed-transaction evidence) — that is the type-level precondition for LIVE PnL, not LIVE PnL |

### Inventory headline counts (72 items classified)

| Classification | Count |
|---|---|
| `PRODUCTION_VERIFIED` | 3 |
| `DEPLOYED_UNVERIFIED` | 16 |
| `MERGED_NOT_DEPLOYED` | 28 |
| `IMPLEMENTED_REVIEWED` | 13 |
| `IMPLEMENTED_UNREVIEWED` | 2 |
| `PARTIAL` | 5 |
| `MISSING` | 5 |
| `SUPERSEDED` | 0 |

Read that top-down: **3 of 72 capabilities have been observed working in production.**
19 are in the running image. The remaining 53 are on branches or in a repo that
does not deploy.

---

## Part 4 — gate checklist

```
[x] production control-plane SHA known
[ ] production engine SHA known
[ ] engine available
[x] engine PAPER-only
[~] Task 6 GREEN
[ ] Railway Linux integration GREEN
[ ] Telegram /start works
[ ] Mini App works
[ ] Start PAPER works
[ ] Status works
[ ] Stop works
[ ] tenant isolation works
[ ] crash recovery works
[x] session state truthful
[x] PAPER clearly labeled
[x] first-value state exists
[ ] zero-candidate state useful
[ ] feedback works
[ ] LIVE-interest capture works
[ ] support works
[ ] telemetry works
[ ] no P0
[ ] no core P1
```

**5 pass · 1 pending · 17 unchecked.**

| Item | Verdict | Evidence, or what is missing |
|---|---|---|
| production control-plane SHA known | **PASS** | Live `/healthz` `release.controlPlaneSha = 2e4da252…`, matching Railway deployment `4025dcce` `meta.commitHash` and `origin/main`. Three independent sources agree. |
| production engine SHA known | FAIL | Live `/healthz` `release.engineSha: null`. Railway `list-variables` returns 37 names; `ARIA_ENGINE_COMMIT_SHA` is absent. |
| engine available | FAIL | No `aria-engine` code in the deployed image — the Dockerfile engine stage exists only on `work/hosted-paper-engine-packaging` (`6901a28`), which is not merged. `CONFIG.ARIA_ENGINE_REPO_PATH` defaults to the dev-machine sibling `../aria-engine`, a path that does not exist in the container. |
| engine PAPER-only | **PASS** | No signing, submission or broadcast module exists on `aria-engine` `main` (`src/` has `paper/`, `discovery/`, `market/`, `safety/`, `strategy/`, `copy/`, `runtime/`, `sync/` — no exec/wallet tree). All LIVE code is confined to the unmerged `impl/live-vertical-slice-0.1-milestone-1`, where `LIVE_ENABLED` and `LIVE_FOUNDER_TELEGRAM_IDS` both default to the closed value and an empty allowlist admits nobody. Enforced on the deployed branch by `test/real1-truthfulness.ts`, which asserts no tier carries a `live` or `jito_bundles` feature. |
| Task 6 GREEN | **PENDING — independent review is running in a separate parallel process; verdict not yet available.** Do not infer an outcome. | Ledger Task 6: `IMPLEMENTED (awaiting review)`, `FAILED x2`. Second re-certification fix is `ed1db8c`; ledger states "A THIRD independent review of this second fix still needs to happen." |
| Railway Linux integration GREEN | FAIL | No such run exists. `fleet-manager.integration.test.ts` has only ever run on the Windows dev machine against a sibling checkout; ledger Task 3 records it at 5/8 there due to sibling-repo drift. Nothing in the Railway build or deploy logs executes it. |
| Telegram /start works | FAIL (no runtime proof) | Handler present at `src/bot.ts:78` and in the deployed image; webhook confirmed healthy (`TELEGRAM_WEBHOOK_OK`, `pendingUpdateCount: 0`). But no `/start` was exercised and no update-handling log line was observed. Deployed ≠ verified. |
| Mini App works | FAIL (no runtime proof) | `public/index.html` is served (`src/server.ts:678`); not opened or exercised this session. |
| Start PAPER works | FAIL | `grep -c "paper_start" src/bot.ts` on `2e4da25` → `0`. The command does not exist in production. Even on the packaging branch it cannot reach `running` — see the pairing-state gap below. |
| Status works | FAIL | Hosted `/paper_status` is not deployed (same grep). The licence `/status` (`bot.ts:171`) is deployed but unverified — and it is a different concept, not engine state. |
| Stop works | FAIL | `/paper_stop` not deployed. |
| tenant isolation works | FAIL | Unit-level proof is real and reviewed (Task 2). Soak-level proof is not certified: Task 6 failed twice, third review outstanding. No hosted tenant has ever run in production. |
| crash recovery works | FAIL | Backoff/give-up logic reviewed (Task 3) but exercised only against `test-fixtures/fake-engine.mjs` on a dev machine. Not deployed, never run in production. |
| session state truthful | **PASS** | `public/app.js:170–173` blanks every counter to `—` and sets `"engine unavailable"` / `"real engine snapshot"` when no snapshot exists, rather than fabricating. Guarded by `test/frontend-reality.ts`. Live `/healthz` likewise reports `engineSha: null` rather than inventing one. |
| PAPER clearly labeled | **PASS** | `public/index.html:29` chip `PAPER EXECUTION`; `:84` heading "You're in PAPER mode"; `:115` panel "Paper Operations"; `:125` "Open Paper Positions"; `:134` "Paper Accounting"; `:150` "Paper Event Stream"; `:281` RISK NOTICE ("executes only deterministic paper trades… never signs or broadcasts transactions and never takes custody"); `src/bot.ts:113` "Paper execution · No real orders · No custody". Machine-enforced by `test/real1-truthfulness.ts`, which asserts `/live terminal/`, `/live trading/`, `/live mainnet execution/` are all absent. |
| first-value state exists | **PASS** | `public/index.html:51` "ARIA is running" panel (commit `47e4202` first-session success moment), `:66` Session summary (`78f13fc`), `:79` Getting started. |
| zero-candidate state useful | FAIL | The only empty state found is `index.html:129` — "pair a local ARIA engine to receive paper snapshots" — which is the **engine-disconnected** case. No distinct copy exists for "engine connected, running, zero candidates so far", which is the state this gate is about. |
| feedback works | FAIL (no runtime proof) | Deployed: `src/feedback.ts`, `bot.ts:400`, `server.ts:633`, migration `1757200000000`. No submission observed. |
| LIVE-interest capture works | FAIL (no runtime proof) | Deployed: `server.ts:592`, `funnel.ts` `live_interest_clicked`. No event observed; funnel counts not read. |
| support works | FAIL (no runtime proof) | Deployed: `bot.ts:242`. Not exercised. |
| telemetry works | FAIL (no runtime proof) | `src/funnel.ts` + `funnel_events` table deployed. The only live counter observed is `/healthz` `leads: 3`, which is the leads table, not funnel telemetry. `getFunnelCounts()` was not queried. |
| no P0 | FAIL | At least one open P0: **hosted pairing-state seeding is missing** (Part 3), which makes hosted PAPER structurally incapable of reaching `running`. Additionally, Task 6's third review is outstanding, so the soak's isolation claim is uncertified — and per this program's own stop conditions, an uncertified isolation claim is treated as a hard safety question, not a minor bug. |
| no core P1 | FAIL | Production engine SHA is unknown and no engine is available in the production image. `ARIA_ENGINE_COMMIT_SHA` and a scoped fetch credential are absent from Railway — Task 7's own named blocking operational precondition, re-confirmed today against the live variable list. |

---

## Part 5 — product-truth audit (governing directive §R)

Surfaces swept: `src/bot.ts`, `public/index.html`, `public/app.js` — all at the
**deployed** SHA `2e4da25`. Terms searched: LIVE, profit, PnL, sniper, MEV, Jito,
copy trading, smart money, AI, automated trading, real trades, wallet, 0-block,
rug protection.

**Nothing was changed. This is a report for a follow-up pass.**

| Claim | Location | Exact text | Classification |
|---|---|---|---|
| "sniper control center" | `public/index.html:9` (meta description) | `ARIA Solana sniper control center. REAL-1 uses real read-only Solana market data with a paired local paper engine; no wallet secret leaves the customer's computer.` | **`UNSUPPORTED`** — see below |
| PAPER execution mode chip | `public/index.html:29` | `PAPER EXECUTION` | `PAPER_ONLY` |
| "You're in PAPER mode" | `public/index.html:84` | `You're in PAPER mode` | `PAPER_ONLY` |
| Realized/Unrealized PAPER PnL | `public/index.html:72–73` | `Realized PAPER PnL` / `Unrealized PAPER PnL` | `PAPER_ONLY` |
| Paper PnL (SOL) | `public/index.html:120` | `Paper PnL (SOL)` · `real engine snapshot` | `PAPER_ONLY` |
| Realized / Unrealized PnL rows | `public/index.html:143–144` | `<strong>Realized PnL</strong>` / `<strong>Unrealized PnL</strong>` | `PAPER_ONLY` — **weakly labeled.** Unlike `:72–73`, these two rows drop the word PAPER. They inherit it only from the enclosing panel heading "Paper Accounting" (`:134`). Worth tightening for parity, but not a false claim. |
| Risk notice | `public/index.html:281` | `…consumes real read-only Solana market data but executes only deterministic paper trades in a separate local client. The Mini App never signs or broadcasts transactions and never takes custody of funds…` | `VERIFIED_PRODUCTION` — accurate for `2e4da25`; no signing/broadcast code is in the deployed image |
| Paid tiers | `public/index.html:214` | `NOTIFY ME WHEN AVAILABLE` | `FUTURE` — honest; live `/healthz` reports `paymentsEnabled: false` |
| Free beta / refunds | `public/index.html:271` | `The current PAPER BETA tier is free — there is nothing to refund or cancel.` | `VERIFIED_PRODUCTION` |
| `/start` product description | `src/bot.ts:113` | `Solana mainnet market data · Paper execution · No real orders · No custody.` | `VERIFIED_PRODUCTION` |
| Wallet handling | `src/bot.ts:115`, `:72–75` | `Burner wallets only. We never ask for your private key.` + `maskWallet()` masking every address to `xxxx...xxxx` | `VERIFIED_PRODUCTION` |
| Engine unavailable states | `public/index.html:115,117`, `app.js:170–173` | `WAITING FOR ENGINE` / `engine unavailable` / `—` | `VERIFIED_PRODUCTION` |
| LIVE / MEV / Jito / copy-trading / smart-money / 0-block / rug-protection / AI / automated-trading | — | **no occurrence in any user-facing surface** | n/a — the sweep found none, and `test/real1-truthfulness.ts` actively asserts `live terminal`, `live trading` and `live mainnet execution` never appear |

### The one `UNSUPPORTED` claim

**`public/index.html:9`** — `<meta name="description" content="ARIA Solana sniper control center. …" />`

"Sniper" is a trade-execution word. In this market it denotes a bot that buys a
newly launched token fast, with real funds. The deployed product executes **nothing**:
there is no engine in the production image (`engineSha: null`), and even when one is
paired it runs deterministic PAPER fills only. The rest of the same sentence does
qualify it ("paired local paper engine"), which is why this is the *only* unsupported
item rather than a systemic problem — but a `<meta description>` is what search engines,
link unfurls and social previews display, frequently truncated at the first sentence.
Truncated at the period, this surface reads **"ARIA Solana sniper control center."**
with the qualifier gone.

It is also the single claim on the deployed surface that the repo's own truthfulness
gate does not catch: `test/real1-truthfulness.ts` greps for `live terminal`,
`live trading` and `live mainnet execution`, and "sniper" is on none of those lists.

Suggested follow-up (not applied in this pass): front-load the qualifier, e.g.
"ARIA Solana PAPER-trading control center", and add `sniper` to the truthfulness
gate's assertions unless a deliberate decision is made to keep the word.

Secondary, lower-priority: `public/index.html:143–144` should read "Realized PAPER PnL"
/ "Unrealized PAPER PnL" for parity with `:72–73`, so those rows do not depend on the
panel heading for their qualifier.

Out of scope but noted: `CLAUDE.md` describes the product as "a paid Solana memecoin
sniper" — an internal contributor document, not a user-facing surface, and not counted
in this audit.

---

## What this reconciliation changes

1. **`aria-engine`'s `main` has moved on and the hosted-engine ledger is stale.**
   Both the commercialization program and `feat/hosted-runtime-dir-override` are
   merged (`9e4d7b0`, `766dcdb`); the ledger at lines 9–10 says they are not and
   tells implementers to spawn off the unmerged branch. Fix that text before
   anyone follows it.
2. **The control-plane chain is clean and self-verifying.** `origin/main` ==
   Railway deployment == live `/healthz`. The build-identity work (`2e4da25`)
   is the reason that is now checkable rather than assumed, and it is the only
   row in Part 2 that is merged, deployed **and** runtime-verified.
3. **Hosted PAPER cannot reach `running` today**, and the reason is a single
   named, re-verified gap: pairing-state seeding. Packaging, the identity gate,
   the fleet supervisor and the Telegram commands are all built and mostly
   reviewed — and all of it is blocked behind one missing file write.
4. **Both LIVE branches will silently revert `2e4da25` if merged as-is.** Rebase
   before merging, or the release-identity instrumentation this document depends on
   disappears.
