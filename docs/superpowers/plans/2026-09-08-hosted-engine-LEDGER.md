# SDD Progress Ledger — Hosted PAPER Engine

Tracks execution of `docs/superpowers/plans/2026-09-08-hosted-engine-plan.md`
(spec: `docs/superpowers/specs/2026-09-08-hosted-engine-design.md`).

- Worktree: `C:\Users\AIWMC\dev\aria-telegram-BOT-APP-hosted-impl`
- Branch: `work/hosted-paper-engine-impl`
- Branched from: `plan/hosted-paper-engine` @ `026be66`
- Sibling engine repo: `C:\Users\AIWMC\dev\aria-engine`, `main` @ `b4ebdb6` (Stage 4). The reference-driven-commercialization program (Tasks 1-9, `work/reference-driven-commercialization-impl`) is NOT yet merged to aria-engine's `main` — this program spawns whichever aria-engine build is checked out at implementation time; confirm which before Task 2 spawns a real process.
- Task 1 opened a small feature branch in aria-engine off `main` (b4ebdb6): `feat/hosted-runtime-dir-override`, pushed to `origin`, commit `69299df`. NOT merged to aria-engine `main` — that merge decision is deliberately left open, not this session's to make. Task 2 (and anything else needing the `ARIA_RUNTIME_DIR` override) must spawn processes off this branch (or a build that includes it) until it's merged.
- **Not in scope, confirmed legacy 2026-09-11**: `sniper-solana`/`C:\solana-sniper` and this repo's own license-signer.ts/Stripe billing system. Do not touch, revive, or build on either.

## Status legend
NOT STARTED / IN PROGRESS / IMPLEMENTED (awaiting review) / REVIEWED-PASS / REVIEWED-FIXED / DONE

| Task | Description | Status | Commit(s) | Reviewer verdict | Notes |
|---|---|---|---|---|---|
| Reconciliation | Post-write plan audit vs. current code | DONE | `026be66` | — | VALID, zero drift, one addendum (audit-paper command) applied |
| 1 | Confirm schema + runtime-path plumbing ready for multi-tenancy | DONE | aria-engine `69299df` (branch `feat/hosted-runtime-dir-override`, NOT merged to aria-engine main); this repo `7e5d7a2` | DONE — REVIEWED-PASS (independent reviewer traced all 9 exported path constants, confirmed the lock file — the highest-risk gap — genuinely moves with the state directory under the override, not left shared; independently re-ran both repos' full suites, 65/65 and 5/5 green) | `ARIA_RUNTIME_DIR` env var added in aria-engine; `hosting_mode` column migration added here. Task 2 must spawn processes off aria-engine's unmerged `feat/hosted-runtime-dir-override` branch until it's merged. |
| 2 | Fleet Manager core (spawn/monitor/stop one tenant process) | DONE | `fdb4796`; review fix `e7c0d4c` | DONE — REVIEWED-PASS after 1 fix cycle (independent re-reviewer reproduced the empirical revert-and-confirm evidence themselves — restored the pre-fix file, watched the new test genuinely fail, restored the fix, watched it pass — and confirmed the mirror spawn-vs-restart race fix, the strengthened isolation test's real OS-level liveness check, and the log cross-contamination test all do what's claimed). Originally: REVIEWER FOUND A REAL, REPRODUCED P0 RACE in `stopTenant()` (see Log) — FIXED. `stopTenant()`'s original `!entry.process` guard treated the "crashed, restart pending" state as "nothing to stop" and returned as a silent no-op without cancelling `entry.restartTimer`, so the scheduled auto-restart fired anyway and resurrected a tenant the caller had just asked to stop. Fix: `stopTenant()` now explicitly handles the no-process case by cancelling `restartTimer` and transitioning to `stopped` for real. New regression test in `fleet-manager.test.ts` reproduces the reviewer's exact timeline and is verified (by running it against the pre-fix `fdb4796` code) to fail on the old code and pass on the fix. Isolation test strengthened per reviewer's secondary finding (OS-level `process.kill(pid,0)` liveness check + survivor log-file untouched check). New log cross-contamination test added. Mirror spawn-vs-restart race investigated and fixed defensively (see Log) though determined not to cause simultaneous live processes in practice. | Depends on: 1 |
| 3 | Resource bounds + crash-loop protection | DONE | `733c24e`; ledger `f22cb34` | DONE — REVIEWED-PASS (independent reviewer hand-traced the backoff formula through all 5 crash counts, verified the sustained-healthy reset is genuinely duration-based not reset-on-every-start, confirmed the concurrency cap excludes stopped/failed tenants, and re-verified Task 2's fixed race wasn't reintroduced in the new failed-status/backoff-timer interactions) | Honest resource-limit finding: no per-process OS-level cap available on this Railway/Docker setup — concurrency cap + crash-loop containment is the real defense, documented as such rather than fabricating an enforcement mechanism that doesn't exist. Backoff: 5s/10s/20s/40s, gives up at crash 5 → terminal `failed` status. Integration-test env issue (sibling repo branch) found and fixed same session; runbook updated to record it as resolved. |
| 4 | Wire Telegram commands to Fleet Manager | DONE | `a0c5ff5`; review fix `b4c4321`; second review fix `1c66e8a` | DONE — REVIEWED-FIXED after 2 fix cycles. First cycle: reviewer found a real, silent P0 — converting an EXISTING `local` client to `hosted` (`startHostedEngine`'s `else if (client.hosting_mode !== "hosted")` branch) flipped only the DB flag and wrote nothing to disk, so the spawned tenant's `aria-engine` process generated an unrelated keypair in its empty runtime dir that could never match the row's original (locally-paired) `device_public_key` — every `/api/engine/sync` call from that hosted process would fail signature verification, permanently and silently. Fixed by generating a real Ed25519 identity for the SAME row, writing it to the tenant's runtime directory, and rotating the row's `device_public_key` to match. Second cycle (2026-09-18): a follow-up review of that fix found the DB-write and disk-write were still ordered DB-then-disk, leaving a narrow crash window that could reintroduce the same P0; a UX gap (no disclosure that the local pairing is being superseded); and a ledger arithmetic error in this row's own prior text (see Log for corrected, freshly-run counts). All three fixed — see Log. Independently re-reviewed a third time (2026-09-18): traced the write-before-commit ordering as genuinely unconditional in both code paths, confirmed `rotateClientDeviceIdentityAndSetHosted` is a real single-statement atomic UPDATE (not two awaits dressed up as atomic), verified the crash-simulation test performs a real second retry that self-heals (not just "error caught"), and independently re-ran the test file to get 90/90 passing — matching the claim exactly and closing out this row's own prior arithmetic errors for good. | Depends on: 2, 3 |
| 5 | Dual-mode (local + hosted) coexistence test | IMPLEMENTED (awaiting review) | `e874097` | | Depends on: 4 |
| 6 | Soak the Fleet Manager itself | IMPLEMENTED (awaiting review) | `54ca099`; first re-certification fix `1123008`/`5f92185`; second re-certification fix `ed1db8c` | FAILED x2 — first soak: vacuous isolation checks (fixed). Second review: first fix's per-tenant-FleetManager-instance topology made the in-memory isolation channel structurally unable to detect the bug class it exists to catch (fixed by restoring one shared instance). A THIRD independent review of this second fix still needs to happen. | Depends on: 2, 3 |
| P0 (fix/hosted-pairing-state-seeding) | Hosted `/paper_start` never seeded `pairing-state.json`/entitlement token — real `aria paper start` would fail closed with "Device is not paired" for EVERY hosted tenant, regardless of engine packaging or Fleet Manager correctness | REVIEWED-PASS | `ce0e48d`; SHA record `977d379` | REVIEWED-PASS (2026-09-19, independent adversarial review — see Log). Verified by reproduction, not self-report: genuine reuse of `issueReal1BetaEntitlementToken` (no second signer), private key never leaves `engine-entitlement-signer.ts` and no `.env` in this worktree, real aria-engine modules imported by the tests with both negative controls passing, real-CLI seeded-vs-unseeded control re-run independently, write-before-commit ordering traced in both call sites, 0o600/0o700 modes matched, typecheck clean and 345 PASS / 0 FAIL re-run. Two REQUIRED FOLLOW-UPS before wider rollout, neither blocking merge: (1) the disclosed revocation gap is real and broader — hosted-only tenants get no `engine_entitlements` row at all, so there is no UUID for `/revokeengine`; mitigated by `engine_clients.status='revoked'` and operator-side `stopTenant`; (2) NEW, undisclosed — the 7-day token is minted once and never renewed, so a hosted tenant silently crash-loops on day 8 with a `aria pair <CODE>` instruction it cannot follow. | Depends on: 4 (reuses `registerHostedClient`/`convertClientToHosted`'s existing device-identity call sites and write-before-commit discipline) |
| P0-follow-up (fix/hosted-entitlement-renewal) | Closes follow-up (2) from the P0 row above: the 7-day ARIAE1 entitlement token is minted exactly ONCE (at tenant create/convert time) with no re-seed path, so every hosted tenant older than 7 days permanently fails the entitlement gate on its next `/paper_start` or FleetManager auto-restart, with an unfollowable "run `aria pair <CODE>`" denial message | IMPLEMENTED (awaiting review) | (pending — see Log) | | Depends on: P0 (fix/hosted-pairing-state-seeding) — reuses `issueReal1BetaEntitlementToken`/`writeHostedPairingStateToDisk` and the write-before-spawn ordering that fix established |

## Stop conditions
- A task's acceptance criteria cannot be met without violating PAPER-only guardrails (no wallet/signing/broadcast anywhere in the Fleet Manager or spawned processes) → STOP, report.
- One tenant's crash/misbehavior is found to affect another tenant or the Fleet Manager itself → STOP that task, this is a hard isolation-safety failure, not a minor bug.
- A reviewer finds a P0 issue the fix/re-review cycle cannot close after 2 attempts → STOP, report.
- A task's dependency is not DONE → do not start it out of order.

## Log
- 2026-09-11 — Ledger created. Worktree created. Reconciliation confirmed VALID with one addendum already applied to the plan doc. Starting Task 1.
- 2026-09-11 — Task 1 implemented.
  - **aria-engine investigation**: Read `src/runtime/paths.ts`, `single-instance.ts`, `src/cli.ts` in full. Confirmed the gap precisely: `RUNTIME_DIR`/`STATE_DIR`/`LOGS_DIR`/`RUN_DIR`/`CONFIG_PATH`/`PAPER_SNAPSHOT_PATH`/`EVENTS_LOG_PATH`/`LOG_FILE_PATH`/`LOCK_FILE_PATH` are all module-level constants in `paths.ts` computed once from `os.homedir()`, with no env-var or CLI-flag override. `ensureRuntimeDirs(root)` and `acquireLock(lockPath)`/`releaseLock(lockPath)`/`isLockHeld(lockPath)` DO accept an override parameter (confirming the spec's claim that override-capable plumbing already exists at the function level), but `cli.ts`'s `cmdPaperStart()` (line 373) calls `acquireLock()` with zero arguments, and every other call site (`ensureConfigured()`'s `RUNTIME_DIR` check, `createOrRestoreEngine(...,PAPER_SNAPSHOT_PATH)`, `new PaperLoop(...,PAPER_SNAPSHOT_PATH)`, `cmdLogs()`'s `LOG_FILE_PATH`) imports the module-level constants directly. No override was reachable outside a test file passing an explicit path. Gap confirmed exactly as the plan's reconciliation predicted.
  - **Fix**: added `ARIA_RUNTIME_DIR` env var, read once in `paths.ts` at module load (`resolveRuntimeDir()`) — if set (and non-blank after trim), `RUNTIME_DIR` resolves to `path.resolve(process.env.ARIA_RUNTIME_DIR)` instead of `path.join(os.homedir(), ".aria")`; every other exported constant derives from `RUNTIME_DIR` as before, so all nine paths move together automatically. No change to `cli.ts`, `single-instance.ts`, or any other call site was needed — since every module imports the constants (not `os.homedir()` directly), fixing the root at the single source-of-truth module was sufficient and is the minimal-surface-area version of "checked once at CLI startup" (this module is among the first things `cli.ts` imports, so it's effectively CLI-startup timing). Chose env var only, per the plan's explicit instruction not to also add a CLI flag.
  - **Test**: `src/runtime/paths.test.ts` (new). Because the constants are computed once at module load, testing both branches honestly requires two separate processes (re-importing in-process would hit ESM's module cache and return the first-computed values) — the test spawns real subprocesses via `tsx/cli` with controlled `env`, asserting (a) every one of the 9 constants relocates correctly under a temp-dir override, (b) omitting the override reproduces the exact pre-existing `~/.aria`-rooted defaults for all 9 constants (the zero-regression property), and (c) a blank/whitespace-only override string is not mistaken for a set one. Added to `package.json`'s `test` script. Full suite (65 test files) green; `tsc --noEmit` clean.
  - **Branch**: aria-engine's `main` is not writable directly per this session's git safety rules. Checked existing branches — no existing branch covers this change — so created `feat/hosted-runtime-dir-override` off `main` (`b4ebdb6`), committed (`69299df`), pushed to `origin`. NOT merged to `main` — that decision is left for later, as instructed.
  - **Schema decision** (aria-telegram-BOT-APP-hosted-impl): read all 5 existing `engine_*` migrations (`create-engine-entitlements`, `create-engine-clients`, `create-engine-pairing-codes`, `create-engine-sync-protocol`, `add-engine-offline-alerts`). Added ONE new migration, `1789169021631_add-engine-clients-hosting-mode.js`: a `hosting_mode` enum column (`'local' | 'hosted'`, default `'local'`) on `engine_clients`. Additive — every existing row is correctly classified as `'local'` with no backfill, matching the "existing local-CLI users must remain fully supported" global constraint. Deliberately did NOT add a `hosted_process_status` column: the design spec's own "Health surface" section says the Fleet Manager should reuse the existing `engine_clients.status`/`last_seen_at` columns the sync protocol already writes ("no parallel state model"), and Task 2's `TenantProcessHandle` shape (pid, restartCount, lastExitCode) is in-memory supervisor state that doesn't belong in this table speculatively before Task 2 exists to prove it's needed — full reasoning recorded in the migration file's own docblock, matching `create-engine-clients.js`'s documentation style.
  - **Test suites, both repos**: aria-engine `npm test` — 65/65 test files pass, 0 failures, exit 0; `npm run typecheck` clean. aria-telegram-BOT-APP-hosted-impl `npm test` (after `npm install`, `node_modules` wasn't present) — all 5 test files pass (`e2e.ts`, `engine-customer-api-contract.ts`, `frontend-reality.ts`, `real1-truthfulness.ts`, `billing-lifecycle.ts`), 0 `❌` markers, exit 0 (this repo's tests deliberately run without `DATABASE_URL`/live Postgres — the migration file itself is not executed by them, matching this repo's existing test-suite design); `npm run typecheck` clean.
- 2026-09-11 — Task 2 implemented: `src/fleet/tenant-process.ts` (one spawned child's lifecycle wrapper — spawn, per-tenant log file, ready-marker detection) + `src/fleet/fleet-manager.ts` (the `FleetManager` class from the plan's interface, unchanged). Tests: `src/fleet/fleet-manager.test.ts` (fake fixture, state-machine + isolation) and `src/fleet/fleet-manager.integration.test.ts` (real `aria-engine` CLI).
  - **Real stop mechanism, investigated then implemented against**: read `cmdPaperControl`/`cmdPaperStart` in aria-engine's `cli.ts` (branch `feat/hosted-runtime-dir-override`, commit `69299df`) directly, confirming the plan's own suspicion — `aria paper stop` is NOT a signal to the running process. It calls `requestDesiredState("stopped")`, which just writes a `desired-state` file under `ARIA_RUNTIME_DIR`; the actual running `paper start` loop only notices on its next ~5s tick (`readDesiredState()`), then transitions its state machine, persists its snapshot, releases its lock, and exits on its own. So `stopTenant(clientId, graceful)` in `fleet-manager.ts` does NOT just fire-and-forget the CLI's `paper stop` — it (1) spawns `aria paper stop` (same `ARIA_RUNTIME_DIR`) so the engine's own cooperative shutdown path runs first (snapshot persisted, lock released cleanly, exactly like a local operator would get), (2) actually WAITS for the tracked child process's own `exit` event, bounded by `gracefulStopTimeoutMs` (default 8000ms — several tick intervals of margin), (3) escalates to `SIGTERM` with a further `sigtermTimeoutMs` (default 4000ms) if the desired-state path hasn't converged, (4) `SIGKILL`s as the last-resort supervised kill, awaited unconditionally so `stopTenant` never returns while the OS process handle is still alive. `graceful=false` skips step 1 and goes straight to `SIGTERM`→`SIGKILL`, for an admin/force-stop path that shouldn't wait out a cooperative cycle. Verified against the fake fixture (`test-fixtures/fake-engine.mjs`), which deliberately reimplements the SAME desired-state-file protocol (not a trivializing fake) so this logic is exercised faithfully — the "graceful stop converges well under the SIGTERM fallback timeout" assertion in `fleet-manager.test.ts` proves the desired-state path is what actually resolved the stop, not the kill fallback masking a broken graceful path.
  - **Restart backoff**: fixed 5000ms (`DEFAULT_RESTART_BACKOFF_MS`, overridable via `FleetManagerOptions.restartBackoffMs`), documented in `fleet-manager.ts`'s docblock as the deliberate v1 answer — long enough that a crash-looping tenant doesn't hot-loop CPU or spam its own log, short enough that a transient blip recovers quickly. Task 3 is explicitly named as the owner of the fuller policy (exponential backoff, max-restarts-per-window cap) on top of this fixed-delay v1.
  - **Double-spawn decision**: `spawnTenant` on an already `starting`/`running` tenant is a **no-op returning the existing handle** (same object, not a new process) — chosen over rejection because the expected caller (Task 4's Telegram "Start" button) can legitimately race a double-tap or retried webhook, and forcing every caller to pre-check `getTenantStatus` first buys nothing. A tenant currently `stopping` is different and IS rejected (throws) — a spawn racing a not-yet-released lock file mid-stop is a real correctness hazard, not a harmless double-tap, so the caller must wait for the in-flight stop to finish. Both branches are tested (`fleet-manager.test.ts`: "double spawnTenant on a running tenant returns the SAME handle object", "spawnTenant while a stop is in flight is rejected").
- 2026-09-11 — **Task 2 review fix**: reviewer reproduced a real P0 race against the fake fixture (verified timeline: `[t=0] status: crashed` → `[t=2ms] stopTenant() resolved. status: crashed` → `[+400ms] status: crashed pid: undefined` → `[+600ms] status: starting pid: 60908` → `[+800ms] status: running pid: 60908` — resurrected after "stop" had already returned as if it succeeded, and stayed running indefinitely).
  - **Root cause**: `stopTenant()`'s entry guard was `if (!entry || !entry.process || entry.handle.status === "stopped") return;`. A `crashed` tenant awaiting its scheduled restart has `entry.process === undefined` (the exit handler clears it) but `entry.restartTimer` still armed. `!entry.process` was `true` in that state, so the function returned immediately — a silent no-op that never touched `entry.restartTimer` or `entry.handle.status`. The pending `setTimeout` fired on schedule regardless and called `this.launch(entry, true)`, respawning the process the caller had just asked to stop.
  - **Fix** (`src/fleet/fleet-manager.ts`): `stopTenant()` now only early-returns on `!entry || entry.handle.status === "stopped"`. A separate `if (!entry.process)` branch (covering the crashed/pending-restart state) explicitly `clearTimeout`s `entry.restartTimer`, clears the field, and sets `entry.handle.status = "stopped"` before returning — a real stop, not a no-op. Traced every other reference to `entry.restartTimer`: (1) the exit handler in `launch()` sets it only in the crash branch and never reads a stale one; (2) the original `stopTenant()` body (the "has a live process" path) already cleared it defensively before driving the graceful/SIGTERM/SIGKILL sequence — unchanged, and since the new no-process branch returns before reaching that code, there is no double-clear. Verified idempotency: calling `stopTenant()` again after it has already stopped a crashed tenant hits the top-level `entry.handle.status === "stopped"` early return and is a safe no-op (new test asserts this explicitly).
  - **Mirror case investigated (spawnTenant vs. pending restart timer)**: `spawnTenant()` on a `crashed` tenant falls through to call `launch()` directly, and originally did NOT cancel `entry.restartTimer` first. Traced the actual reachable outcome: `launch()` synchronously sets `entry.handle.status = "starting"` before any awaited operation, so if the OLD restart timer's callback fires afterward, its own guard (`if (entry.handle.status !== "crashed") return;`) sees a non-crashed status and no-ops — no second live process is spawned in the simple case. However, a real (if narrow) hazard remains: if the explicitly-spawned process itself crashes again before the old timer's original backoff window elapses, `entry.handle.status` flips back to `"crashed"` and a NEW restart timer is scheduled — at which point the STALE old timer, still pending and now passing its `status === "crashed"` guard by coincidence, fires an extra unwanted `launch()` call racing the legitimate new timer (in practice this collapses to one restart firing earlier/more often than the documented backoff intends, not two simultaneously-live processes, because `entry.process` is always overwritten by whichever `launch()` runs last — but it is a real violation of the backoff contract and a dangling timer reference regardless). Fixed defensively and symmetrically with the `stopTenant()` fix: `spawnTenant()`'s crashed/stopped fall-through branch now `clearTimeout`s and clears `existing.restartTimer` before calling `launch()`, exactly as `stopTenant()` does, removing the dangling reference entirely rather than relying on the status guard to save it.
  - **Test coverage added** (`src/fleet/fleet-manager.test.ts`): (1) regression test reproducing the reviewer's exact timeline — crash a tenant, call `stopTenant()` during the pending-restart window, then sleep past `restartBackoffMs + 400ms`, and assert `status === "stopped"`, `pid === undefined`, and `restartCount === 0` (not just that `stopTenant()` didn't throw); verified by temporarily restoring the pre-fix `fdb4796` version of `fleet-manager.ts` and re-running this exact test file — it failed on 4 of its new assertions against the old code ("stopTenant() resolves with status stopped, not left crashed", "no resurrection: tenant is still stopped...", "status remains stopped after the redundant second stopTenant() call") and passed all of them once the fixed file was restored. (2) Isolation test strengthened per the reviewer's secondary finding: added an OS-level `process.kill(survivorPid, 0)` liveness check (throws if the process doesn't actually exist — proves the survivor's REAL process is alive, not just that FleetManager's in-memory bookkeeping was untouched) and a check that the survivor's per-tenant log file content is byte-identical before/after the victim's kill. (3) New log cross-contamination test: two tenants spawned via the fake fixture (extended with a new `FAKE_EXTRA_LINE` env knob in `test-fixtures/fake-engine.mjs` to print a distinctive line per tenant), asserting each tenant's log file contains only its own line and never the sibling's.
  - **Test/typecheck results**: `npx tsx src/fleet/fleet-manager.test.ts` — 44/44 checks pass (was 30, net +14 new assertions, zero regressions on the pre-existing ones). `npx tsx src/fleet/fleet-manager.integration.test.ts` — 8/8 pass, unaffected by this fix (integration test never exercises the crash/restart path). Full `npm test` — exit 0, all pre-existing suites unaffected (the 401/DB-error lines in the log are pre-existing intentional fail-closed negative-path assertions, not failures). `npm run typecheck` — clean.
  - **Double-stop decision**: `stopTenant` on an untracked `clientId`, or one already `stopped`, is a safe no-op (no throw, nothing to do) — tested directly, including calling `stopTenant` twice in a row on the same tenant. A `stopTenant` call that arrives while another is already in flight for the same tenant awaits the SAME in-progress stop (`stopInFlight` promise) rather than starting a second redundant stop sequence or racing signals against itself.
  - **Isolation test — what was actually crashed and what was actually verified**: `fleet-manager.test.ts`'s isolation block spawns two real (fixture) child processes, `victim` and `survivor`, waits for both to reach `running`, then calls `process.kill(victimPid, "SIGKILL")` DIRECTLY on the OS process — bypassing FleetManager's own `stopTenant` entirely, i.e. an external kill exactly like an OOM-killer or a manual `kill -9` on a runaway tenant would be, not a simulated/mocked crash. Verified afterward, all as real assertions against live state (not comments/assumptions): (a) `victim` is detected as `crashed` (its exit is observed and classified correctly even though FleetManager didn't cause it); (b) `survivor`'s status is STILL `running`, its `pid` is UNCHANGED, and its `restartCount` is still `0` — i.e. genuinely untouched, not just "didn't error"; (c) the `FleetManager` instance itself is still fully functional afterward — proven by actually spawning a brand-new third tenant (`post-kill-newcomer`) post-kill and confirming it spawns correctly, not just asserting no exception was thrown; (d) `victim` still recovers on its own via the same restart-backoff path any ordinary crash uses (`restartCount` increments, reaches `running` again) — proving the SIGKILL was handled by the SAME crash-handling code path as a normal nonzero exit, not a special-cased/untested branch. This is the single test the plan's Global Constraints calls mandatory, and it asserts containment, not just absence-of-error.
  - **Real-CLI integration test — what it proves and its one honest limitation**: `fleet-manager.integration.test.ts` spawns the ACTUAL `aria-engine` CLI (`node --import tsx src/cli.ts paper start`, unmodified, from the sibling checkout on `feat/hosted-runtime-dir-override`) via `FleetManager`, and verifies against REAL behavior (not the fake fixture): the tenant-scoped `ARIA_RUNTIME_DIR` override threads all the way through the real binary (its own `config.json` lands under the tenant-scoped temp dir, confirmed by direct manual runs of `aria doctor`/`aria paper start` with and without the override before writing the test); the per-tenant log file captures the real process's real stdout; and FleetManager correctly classifies a real nonzero-exit CLI process as `crashed` (never falsely `running`) with the correct captured exit code. It does NOT reach a `running` `paper start` against the real binary, and documents exactly why in its own docblock: `aria paper start` requires (1) a real `aria pair <CODE>` pairing against the live control plane and (2) a control-plane-signed ARIAE1 entitlement token verified against a public key baked into aria-engine's compiled source — the matching private key (`ARIA_ENTITLEMENT_PRIVATE_D`) exists only in this repo's PRODUCTION Railway environment (`src/engine-entitlement-signer.ts`), confirmed absent from this dev worktree (no `.env` file present), and forging a token would require either that secret or modifying aria-engine's baked-in public key/gate logic — both correctly out of reach/out of scope. This was verified directly, not assumed: manual `ARIA_RUNTIME_DIR=<tmp> node --import tsx src/cli.ts paper start` in the real aria-engine checkout fails immediately with `"Device is not paired. Run \`aria pair <CODE>\` first."`, exit 1 — exactly the fail-closed behavior the entitlement design promises, and exactly what the automated integration test now asserts FleetManager handles correctly. The full happy-path "reaches running" state-machine proof is instead covered by the fake fixture in `fleet-manager.test.ts`, which was deliberately built to reimplement the real engine's actual desired-state stop protocol (not a trivializing fake) so that proof isn't hollow. A genuine real-binary "reaches running" test needs a staging/CI environment holding a real (or dedicated staging) entitlement signing key — flagged here as a real, named gap for whoever sets up that environment, not silently worked around.
  - **Test suites, full repo**: `npm test` (now includes `fleet-manager.test.ts` and `fleet-manager.integration.test.ts` appended to the script) — all prior suites (`e2e.ts`, `engine-customer-api-contract.ts`, `frontend-reality.ts`, `real1-truthfulness.ts`, `billing-lifecycle.ts`) plus both new Fleet Manager suites pass, 0 `❌` markers, exit 0 (pre-existing `DATABASE_URL`/Resend-401 error log lines are expected noise from tests that intentionally run without those live services, unchanged from before this task — confirmed not new). `npm run typecheck` clean. Zero regressions.
- 2026-09-14 — Task 3 implemented: `src/fleet/fleet-manager.ts` extended (no new files needed beyond the runbook), `src/fleet/fleet-manager.test.ts` extended with new assertions. `docs/FLEET_MANAGER_RUNBOOK.md` (new).
  - **Real resource-limit mechanism, investigated (honest finding, not fabricated)**: read this repo's `Dockerfile` (`node:22-slim`, `npm start`, no cgroup/`ulimit`/resource directives anywhere) and `railway.json` (`restartPolicyType`/`restartPolicyMaxRetries`/healthcheck for the WHOLE service only — no per-process resource concept exists in this config surface at all). Conclusion, stated plainly in the runbook: Railway's actual resource control is service-level (a single vCPU/RAM ceiling for the whole container, set in the dashboard, shared by every tenant's child process AND the Fleet Manager's own process) — there is no OS-level per-child-process hard cap available from plain Docker-on-Railway without container-per-tenant infrastructure this project doesn't have (the design spec's own "Future Work" already names that as a separate, deferred program). `NODE_OPTIONS=--max-old-space-size=N` would only cap a child's V8 heap, not total RSS/CPU, and is explicitly documented as NOT a security boundary. Given this, the PRIMARY defense implemented is Fleet-Manager-level: a hard concurrent-tenant-count cap (bounds total footprint, since per-tenant footprint is small/known) plus crash-loop containment (bounds one misbehaving tenant's CPU/log churn) — not a fabricated OS-level cap. Full reasoning in `docs/FLEET_MANAGER_RUNBOOK.md` §1.
  - **Concurrent-tenant cap**: `FleetManagerOptions.maxConcurrentTenants`, default 5 (matches the plan's own "MAX_HOSTED_USERS=3 or 5" language). Counts tenants in `starting`/`running`/`stopping` status. `spawnTenant()` now throws a new typed `FleetCapacityError` (carries `.clientId`/`.limit`) once the cap is reached — checked AFTER the existing no-op (already-running) and rejection (mid-stopping) branches, so it only fires for a spawn that would actually consume a NEW slot (a brand-new clientId, or a manual respawn of a stopped/crashed/failed tenant), never for calls that don't need one. Tested: spawn to the limit, next spawn rejected with the typed error and never tracked, stopping one tenant frees a slot for a new spawn which then reaches `running`.
  - **Crash-loop backoff — exact numbers and reasoning** (replaces Task 2's fixed 5000ms, which its own docblock named as "a deliberate v1 answer" for Task 3 to supersede): exponential, `min(restartBackoffMs * 2^(consecutiveCrashes-1), maxRestartBackoffMs)` — base `restartBackoffMs=5000ms` (unchanged default from Task 2, now the base of a doubling series instead of a flat delay), capped at `maxRestartBackoffMs=5*60*1000=300000ms` (5 minutes). Give-up threshold `maxConsecutiveCrashes=5`: after 5 consecutive crashes without an intervening sustained-healthy run, auto-restart stops entirely and the tenant transitions to the new terminal `"failed"` status with no timer armed. Reset condition `sustainedHealthyMs=60000ms` (60s): if a (re)started process stays `running` for at least 60 seconds before its next crash, `consecutiveCrashes` resets to 0 (then increments to 1 for the new crash) instead of continuing to escalate from an unrelated earlier incident — tracked via a new `runningSince` timestamp on `TenantEntry`, set in the `ready` event handler and cleared in both exit-handler branches so it can never leak a stale value across a stop/restart cycle. All four numbers and the full reasoning for each are documented inline in `FleetManagerOptions`'s JSDoc and in `docs/FLEET_MANAGER_RUNBOOK.md` §3.
  - **`crashed` vs `failed` status decision (explicit, not a default)**: split them. `TenantProcessHandle.status` gained `"failed"` alongside the existing `"crashed"`. `crashed` = transient, a restart IS scheduled; `failed` = terminal, the Fleet Manager gave up, nothing is scheduled, a human or an explicit `spawnTenant()` call is needed. Reasoning: collapsing both into one status would force Task 4's Telegram status surface to either lie ("still trying!" when nothing is scheduled) or introspect internal timer state to tell them apart — splitting lets the bot show "retrying in ~Ns" vs "failed, tap Restart" honestly from the handle alone. Also added `consecutiveCrashes: number` to `TenantProcessHandle` (was previously internal-only) so a status surface can show "crashed 3/5" instead of a bare boolean.
  - **Manual intervention — confirmed already-sufficient, documented rather than rebuilt**: `spawnTenant(clientId)` on a `failed` tenant already falls through to the same respawn path `crashed`/`stopped` used (no new status-specific branch needed), with one addition this task makes: the fall-through now resets `consecutiveCrashes` to 0 and clears `runningSince` before respawning, so a manual retry always gets the FULL backoff/give-up budget again rather than inheriting an already-escalated state. Documented in `docs/FLEET_MANAGER_RUNBOOK.md` §5 as the operator-facing "how do I restart a failed tenant" answer — no new API surface was needed.
  - **Traced against Task 2's already-fixed `stopTenant()` race — confirmed not reintroduced in a new form**: (1) `stopTenant()`'s `!entry.process` branch (Task 2's fix, which unconditionally cancels a pending `restartTimer` for a crashed-with-pending-restart tenant before setting `status="stopped"`) is UNCHANGED by this task and still runs identically regardless of `consecutiveCrashes` history. (2) The new `"failed"` status is only reached from the exit handler's give-up branch, which sets `entry.restartTimer = undefined` WITHOUT scheduling one — so a `failed` tenant never has a dangling timer to leak in the first place; `stopTenant()`'s early-return guard was extended to `status === "stopped" || status === "failed"` (both terminal, nothing to cancel) rather than routing `failed` through the `!entry.process` branch unnecessarily. (3) `spawnTenant()`'s existing dangling-timer defense (clearing `existing.restartTimer` before respawn, added in Task 2's review fix) runs BEFORE this task's new `consecutiveCrashes` reset — order: cancel timer → reset crash counter → capacity check → `launch()`; a new test ("spawnTenant on a 'failed' tenant is accepted (manual retry)... consecutiveCrashes was reset to 0") exercises this exact sequence end-to-end. (4) The new `runningSince` field is cleared in BOTH exit-handler branches (`wasStopping` and the crash branch), so it cannot persist a stale timestamp across a stop/restart cycle. No new dangling-timer or stale-state bug found. Full trace in `docs/FLEET_MANAGER_RUNBOOK.md` §6.
  - **New tests** (`src/fleet/fleet-manager.test.ts`, appended): concurrent-cap rejection/recovery (4 checks + capacity-error identity checks), crash-loop escalation to `consecutiveCrashes` 1→2→3(give-up)→`failed`-stays-failed→manual-retry-resets-to-0 (13 checks), sustained-healthy reset (6 checks). All verified against the FAKE fixture (`test-fixtures/fake-engine.mjs`, unchanged — no new fixture knobs were needed, existing `FAKE_CRASH_AFTER_MS`/`FAKE_EXIT_CODE` env knobs plus test-controlled timing sufficed). Result: 65/65 checks pass (was 44, net +21 new assertions, zero regressions on the pre-existing 44 — re-verified by running the full file before AND after this task's changes).
  - **Test/typecheck results**: `npx tsx src/fleet/fleet-manager.test.ts` — 65/65 pass. `npm run typecheck` — clean. `npm test` (full suite) — all pre-existing suites (`e2e.ts`, `engine-customer-api-contract.ts`, `frontend-reality.ts`, `real1-truthfulness.ts`, `billing-lifecycle.ts`) and `fleet-manager.test.ts` pass with 0 `❌` markers. `fleet-manager.integration.test.ts` shows 5/8 passing, NOT 8/8 as Task 2's ledger entry recorded — investigated, NOT a Task 3 regression: the 3 failing assertions (tenant-scoped runtime dir/config.json/log content produced by the REAL `aria-engine` binary) depend on the sibling `aria-engine` checkout at `C:\Users\AIWMC\dev\aria-engine` having `feat/hosted-runtime-dir-override` checked out; that worktree's `HEAD` is currently on `main` (confirmed by direct `git branch --show-current`/`git log` inspection — not assumed), which lacks the `ARIA_RUNTIME_DIR` support that branch adds. Confirmed this is pre-existing and unrelated to this task's code by temporarily `git stash`-ing this task's changes and re-running the integration test against Task 2's exact committed baseline (`46d2e61`) — the identical 3 assertions fail there too, byte-for-byte the same failure set. This is a sibling-repo checkout/environment drift (out of this task's and this program's scope — this repo's Global Constraints explicitly forbid touching `aria-engine` beyond what Task 1 already did), documented honestly in `docs/FLEET_MANAGER_RUNBOOK.md` §8 rather than silently worked around or hidden. Zero regressions on anything actually in this task's scope.
  - **Commit**: `733c24e`.
- 2026-09-18 — Task 4 implemented: `src/bot.ts` (modified), `src/fleet/hosted-commands.ts` (new, testable command logic), `src/fleet/hosted-commands.test.ts` (new), `src/fleet/instance.ts` (new, the shared `FleetManager` singleton), `src/fleet/hosted-device-identity.ts` (new), `src/engine-clients.ts` (modified — `setHostingMode()` + `hosting_mode` on `EngineClient`), `src/config.ts` (modified — `ARIA_ENGINE_REPO_PATH`/`FLEET_TENANTS_ROOT`/`FLEET_LOGS_ROOT`/`FLEET_MAX_CONCURRENT_TENANTS`), `package.json` (added the new test file to `npm test`).
  - **Environment precondition confirmed first, per this task's own instructions**: `C:\Users\AIWMC\dev\aria-engine` was already on `feat/hosted-runtime-dir-override` @ `69299df` (not `main`) at the start of this session — `git branch --show-current` and `git log -1` both checked directly, not assumed. Ran `npm run build` there anyway (clean) before touching this worktree, per the instruction to always verify+rebuild it before relying on the integration test.
  - **Step 1 — confirmed exactly what existed in `bot.ts` before changing anything**: read the entire file (563 lines). Confirmed precisely: the real command set was `/start /license /status /licensekey /pair /support /notifications /help` plus admin `/stats /invite /invites /beta /attribution /feedback /revoke /revokeengine` — matching `CLAUDE.md`'s inventory with `/pair` and `/notifications` additionally present (not listed in that file, which predates them). **No existing command told users to run a local CLI command to START the engine** — `/pair` gives the user a code and tells them to run `aria pair <CODE>` locally (a PAIRING instruction, not a start/stop/pause instruction), and nothing else in the file references `aria paper start`/`stop`/`pause` at all. So "hosted-start" is entirely new command surface, not a rewire of an existing "run this locally" message — Step 1's premise in the plan ("today it likely just sends the user instructions to run a local CLI command") does NOT hold for start/stop/pause specifically in this codebase's actual current state, only for pairing; documented here rather than silently assumed true.
  - **Command names/UX chosen, and why**: `/paper_start`, `/paper_stop`, `/paper_status` — three new top-level commands, not an extension of `/pair` (a fundamentally different concept: `/pair` is for a LOCAL device that already exists and needs to register itself; a hosted tenant has no local device at all) and not an extension of `/status` (already a fixed, documented alias for the LICENSE status view — overloading it with engine-process state would conflate two unrelated "status" concepts the same way `/license`/`/status` already deliberately alias each other for ONE concept). The `paper_` prefix matches aria-engine's own `aria paper start/stop` CLI vocabulary named in the design spec's Task 4 section, so a user who has seen either surface (Telegram or a local terminal) recognizes the other. Added to `/help`'s listing.
  - **`FleetManager` constructed once, reusably** (per the plan's explicit Task 4 instruction and the command-console spec's future need): `src/fleet/instance.ts` exports a single `fleetManager` instance built from `CONFIG` at module load, plus a `tenantRuntimeDir(clientId)` helper that mirrors `FleetManager`'s own private `runtimeDirFor()` convention without either module reaching into the other's internals. `bot.ts` imports this instance; it never constructs its own. **Note on the referenced command-console spec**: `docs/superpowers/specs/2026-09-11-command-console-design.md` does not exist anywhere in this repo/worktree (`find docs -iname "*2026-09-11*"` and `*console*` both empty) — confirmed by direct search, not assumed missing. Proceeded on this task's own inlined instruction (construct once, make importable) since that requirement was fully specified in the plan/task text itself and doesn't depend on that file's contents; flagging the missing file honestly rather than fabricating what it might say.
  - **Config additions**: `ARIA_ENGINE_REPO_PATH` (default `../aria-engine`, matching this program's own sibling-checkout convention — MUST be set explicitly in any real deployment where aria-engine isn't checked out at that relative path, a real deployment-topology gap this task does not solve and documents rather than silently papers over), `FLEET_TENANTS_ROOT` (default `./data/tenants`, alongside `DB_PATH`'s existing `./data` convention so no second Railway volume mount is needed), `FLEET_LOGS_ROOT` (default `./data/tenant-logs`), `FLEET_MAX_CONCURRENT_TENANTS` (optional — left unset by default so `FleetManager`'s own Task-3 default of 5 applies).
  - **`engine_clients`-row-creation design decision for hosted-only tenants (the task's central open question) — investigated, decided, and implemented**: `device_public_key` is `NOT NULL UNIQUE` (confirmed by reading `migrations/1755500100000_create-engine-clients.js` directly) and the sync protocol (`server.ts`'s `/api/engine/sync`) authenticates a client by verifying an Ed25519 signature AGAINST that stored key (`device-auth.ts`'s `verifyDeviceSignature`) — so whatever value is chosen must be a REAL, functioning public key, not a naming-convention marker string. Read aria-engine's `src/local-keystore.ts` directly to confirm the exact on-disk contract a spawned engine process uses to load its own device identity: `<ARIA_RUNTIME_DIR>/state/device-identity.json` holding `{ publicKeyX, privateKeyPkcs8Base64 }`, loaded via `loadOrCreateDeviceIdentity()` (loads if present, generates+persists only if absent). Decision: generate a real Ed25519 keypair server-side with `node:crypto`'s `generateKeyPairSync("ed25519")` — same primitive, same JWK/PKCS8 encoding aria-engine's own keystore uses — insert the `engine_clients` row with that key as `device_public_key` (`registerHostedClient()` in `bot.ts`), then pre-seed the IDENTICAL keypair into `<tenantsRoot>/<client.id>/.aria/state/device-identity.json` (`writeHostedDeviceIdentityToDisk()`, `src/fleet/hosted-device-identity.ts`) BEFORE the Fleet Manager ever spawns that tenant. When the real `aria-engine` CLI boots for that tenant, `loadOrCreateDeviceIdentity()` finds this pre-seeded file and loads it rather than generating a mismatched one of its own — so the identity in `engine_clients` at row-creation time is byte-identical to the one the running process actually signs sync requests with, with zero separate pairing-code handshake required, matching the product direction of "no terminal, no local pairing step for hosted PAPER." **Collision-avoidance reasoning, explicit**: a synthetic placeholder string (e.g. `"hosted:" + uuid`) would trivially satisfy the `NOT NULL UNIQUE` constraint but would be cryptographically non-functional — the hosted engine's very first real sync call would fail signature verification and the tenant could never actually sync PAPER state, defeating the entire point of hosting it. A real keypair avoids this while remaining collision-free with every other real device key (paired or hosted) for the SAME reason any two independently-paired local devices never collide with each other today: a 32-byte Ed25519 public key drawn from a ~2^256 keyspace. The database's `UNIQUE` constraint remains the hard backstop regardless (an `INSERT` would fail loudly on any clash, never silently overwrite). Full reasoning, including the disclosed cross-repo coupling risk (this format must track aria-engine's `local-keystore.ts` if it ever changes — no shared package enforces this at compile time), is documented inline in `src/fleet/hosted-device-identity.ts`'s docblock.
  - **`hosting_mode` set correctly in both paths**: a brand-new hosted-only client is inserted already `hosted` (via `setHostingMode()` immediately after `registerClient()`, since `registerClient()` itself has no `hosting_mode` parameter and the migration's own default is `'local'`). An EXISTING local-paired client that runs `/paper_start` for the first time gets `setHostingMode(client.id, "hosted")` called on it (only if not already `hosted`) — the row is never recreated, `client.id` (and therefore the tenant's runtime directory and its ALREADY-PAIRED real device identity) is preserved exactly, so a user who paired locally weeks ago and then chooses to go hosted keeps the same identity/history, they don't get a second, unrelated `engine_clients` row.
  - **Honest status reporting, never a fabricated "all good"**: `getHostedStatus()` returns `undefined` for a user with no client OR a client the Fleet Manager has never tracked (never called `spawnTenant` for it) — both are genuinely "never started." A tenant that WAS running and was later stopped keeps its handle with `status: "stopped"`, which `formatHostedStatusMessage()` renders as a DIFFERENT, explicit string ("_Never started_" vs "⚪ *Stopped*") — tested directly (`"never-started and stopped render different text"`). `crashed` shows the real `consecutiveCrashes` count and last exit code; `failed` (Task 3's terminal give-up state) is shown as `🔴 Failed` with the real crash count and last exit code, plus a "use /paper_start to try again" hint — never collapsed into a generic "stopped" or "unknown" state.
  - **`FleetCapacityError` translated, never a raw error/stack trace**: `startHostedEngine()` explicitly catches `err instanceof FleetCapacityError` first and returns a typed `{ reason: "capacity", message: "...try again in a few minutes." }`; any OTHER thrown error (a DB failure, an unexpected Fleet Manager exception) falls through to a SEPARATE generic plain-language message — neither branch ever includes the error object, its `.message`, or a stack trace in the outbound DM. Tested directly (`"DM never contains 'FleetCapacityError' or a stack trace"`).
  - **User-isolation test, explicit and passing** (`src/fleet/hosted-commands.test.ts`, final block): two different users (`userId 800`/`900`, distinct `telegramUserId`s) each run `/paper_start`, confirmed to receive DIFFERENT `engine_clients` ids. User A then runs `/paper_stop` — verified `stopTenant()` was called for A's client id and NEVER for B's; verified B's `TenantProcessHandle` is completely unaffected afterward (still `running`, same `pid`, unchanged `restartCount` — not just "no exception was thrown"); verified neither user's status DM text contains the OTHER user's client id (the identifier itself never leaks across the boundary in outbound messages); verified each DM was addressed to the correct `telegramUserId`. This is possible only because `startHostedEngine`/`stopHostedEngine`/`getHostedStatus` all resolve the target `clientId` EXCLUSIVELY from the caller's own `userId` (itself resolved by `bot.ts` from Telegram's own authenticated `ctx.from.id`, via the existing `getUserByTelegramId`/`upsertUserFromTelegram` — matching the plan's "never trust client-supplied IDs" instruction) — there is no code path, parameter, or command argument through which one user's command could name or target another user's `clientId`.
  - **Test/typecheck results**: `npx tsx src/fleet/hosted-commands.test.ts` — 40/40 checks pass. `npm run typecheck` — clean, zero errors. Full `npm test` (now 7 suites, including the two new hosted-commands assertions appended to the script) — exit 0, `grep -c "❌"` on the full output returns `0`, 228 total `✅` lines. `npx tsx src/fleet/fleet-manager.integration.test.ts` run specifically, on its own, per this task's instructions — **8/8 pass**, confirming the sibling-repo-branch environment issue (Task 3's ledger entry, §8 of the runbook) did not resurface, because the branch precondition was verified and correct before this session began.
  - **Commit**: `a0c5ff5` (code + this ledger entry); this exact SHA recorded in a small follow-up ledger-only commit, matching Task 3's own `733c24e`/`f22cb34` two-commit pattern.
- 2026-09-18 — Task 4 REVIEW FIX. **The bug (real P0, confirmed by direct code reading before any fix was attempted)**: `startHostedEngine()`'s two branches were NOT symmetric. The `!client` branch (`registerHostedClient()`) generates a real Ed25519 keypair, inserts it as `device_public_key`, AND pre-seeds the identical keypair into the tenant's runtime directory before ever spawning. The `else if (client.hosting_mode !== "hosted")` branch — reached when a user who already paired a LOCAL device via `aria pair <code>` runs `/paper_start` for the first time — called only `setHostingMode(client.id, "hosted")`: a bare DB-flag flip, no disk write at all. That row's `device_public_key` is the LOCAL device's public key; its private half was generated on the user's own machine by `aria pair` and never sent to (or held by) the server. When `spawnTenant()` then launched the real `aria-engine` CLI into a fresh, empty `<tenantsRoot>/<clientId>/.aria` directory, that process's own `loadOrCreateDeviceIdentity()` (aria-engine's `local-keystore.ts`) found no `state/device-identity.json` there and silently generated a BRAND-NEW, unrelated keypair — one that can never match the OLD `device_public_key` already stored in the row. Net effect: `/paper_start` reports success, `/paper_status` would even show "running", but every real `/api/engine/sync` call from that process fails signature verification (`device-auth.ts`'s `verifyDeviceSignature`) — permanently, silently, invisible at the point of failure. This is exactly the kind of "reports success, quietly non-functional" defect this program's Global Constraints and every prior task's reviewer have been most alert to.
  - **Design decision — rotate the EXISTING row's identity in place, NOT create a second `engine_clients` row for the hosted identity.** Both options were weighed:
    - *Rotate in place (chosen)*: generate a fresh keypair, write it to the SAME tenant runtime directory, `UPDATE` the SAME row's `device_public_key`, flip `hosting_mode` to `hosted`. `client.id` — and everything keyed off it (the Fleet Manager's tenant slot, `getLatestActiveClientForUser`'s single-row-per-user return, the existing `hosted-commands.test.ts` isolation contract) — is completely unchanged.
    - *Separate row per hosting mode*: leave the local row's identity untouched, insert a SECOND `engine_clients` row (hosted-only) for the same user, and have `getLatestActiveClientForUser`/`spawnTenant` operate on that new row for hosted purposes instead.
    - **Rotate-in-place was chosen** for two independent reasons, one architectural and one product. Architecturally: this codebase already commits to "one active client row per user, mutated in place across state transitions" — `getLatestActiveClientForUser()` returns exactly one row, and `hosted-commands.test.ts`'s PRE-EXISTING test ("spawnTenant was called with the EXISTING client id, not a new one") already asserts the SAME `client.id` is reused across the local→hosted transition; a second-row design would silently break that contract (this task's instruction to extend, not break, the existing 40 checks makes this decisive on its own). On the product side: `setHostingMode`'s own pre-existing docstring already states hosting_mode "never flips a client BACK to 'local' automatically — that would need its own explicit UX this task doesn't build," i.e. this codebase already treats a hosting-mode transition as a one-way, deliberate act on ONE client identity, not a mode two identities coexist under.
    - **Consequence, disclosed rather than hidden**: the user's ORIGINAL local device identity for THIS `client_id` is permanently superseded the moment they convert it to hosted. If they later run the local `aria` CLI again on the SAME machine with that original identity, its signatures will no longer match this row's (rotated) `device_public_key`, and that local install will need to `/pair` again to get a fresh row. This is judged the correct and honest mental model for this product: "convert this client to hosted" is a deliberate, one-way handoff of that specific client's identity to ARIA's infrastructure — not a request for the same client to have two simultaneously-valid identities depending on which side is running. A future task that wants genuine local+hosted dual-running for one user (Task 5's "dual-mode coexistence" is worth re-checking against this once picked up) would need a deliberate SEPARATE-row design from the start, not a retrofit of this one; flagging that forward-looking implication here rather than silently deciding it.
  - **Fix implementation**: `src/engine-clients.ts` — new `rotateClientDeviceIdentity(id, newPublicKey)` (an `UPDATE ... SET device_public_key = $2 WHERE id = $1`; `registerClient`/`registerHostedClient` only ever `INSERT`, so no existing primitive updated a key on an existing row). `src/fleet/hosted-commands.ts` — `HostedCommandsDeps.setHostingMode` replaced with `convertClientToHosted(clientId): Promise<void>`, and `startHostedEngine`'s `else if` branch now calls it. `src/bot.ts` — new `convertClientToHosted()` (the real implementation wired into `hostedDeps`): generates a fresh identity via `generateHostedDeviceIdentity()`, calls `rotateClientDeviceIdentity()`, calls `setHostingMode()`, then `writeHostedDeviceIdentityToDisk()` into `tenantRuntimeDir(clientId)` — the exact same three primitives `registerHostedClient()` uses for a brand-new row, reused rather than duplicated; `registerHostedClient()` itself was also refactored to call `generateHostedDeviceIdentity()` instead of inlining its own `generateKeyPairSync` call, removing the last duplicate of that logic.
  - **Secondary finding also fixed**: `FleetManager`'s private `runtimeDirFor(clientId)` and `fleet/instance.ts`'s `tenantRuntimeDir(clientId)` independently computed the identical `path.join(tenantsRoot, clientId, ".aria")` in two files with nothing enforcing they stay in sync. `runtimeDirFor` was made a public method on `FleetManager`; `tenantRuntimeDir()` now delegates to `fleetManager.runtimeDirFor(clientId)` instead of recomputing it. No behavior change (verified: `fleet-manager.integration.test.ts`, which asserts the REAL `aria-engine` binary's runtime dir under this exact path, still passes).
  - **New test coverage** (`src/fleet/hosted-commands.test.ts`): a new block exercises BOTH the brand-new-client path and the existing-local-client-converted-to-hosted path with the REAL `generateHostedDeviceIdentity()`/`writeHostedDeviceIdentityToDisk()` functions writing to a real temp directory (`mkdtempSync`), not the fully-in-memory fakes the rest of this file uses for the Fleet Manager/DB. A new `loadAndVerifyDeviceIdentityFile()` helper does NOT just check the file exists: it reconstructs the private key from the stored `privateKeyPkcs8Base64` via `createPrivateKey({format:"der",type:"pkcs8"})` — the exact same reconstruction aria-engine's own `loadDeviceIdentity()` (`local-keystore.ts`) performs — then re-derives the public key from THAT reconstructed key and asserts it round-trips to the SAME `publicKeyX` stored alongside it and to the DB row's `device_public_key`. This proves the file is a genuine, internally-consistent, loadable Ed25519 keypair usable to sign a real sync request, not merely a file with the right shape. The conversion-path test additionally asserts the rotated key is DIFFERENT from the original (pre-rotation) local key, proving a real rotation happened rather than a silent no-op, and that `created === false` / `spawnTenant` was called with the pre-existing `client.id` (the existing contract, still honored).
  - **Test/typecheck/regression results**: `npm run typecheck` — clean, zero errors. `npm test` (full suite, all 8 scripts including `fleet-manager.integration.test.ts` against the real `aria-engine` CLI on `feat/hosted-runtime-dir-override` @ `69299df`, confirmed via `git branch --show-current`/`git log` before running) — exit 0, zero `❌` lines. `hosted-commands.test.ts` specifically: all 40 pre-existing checks pass unchanged (net-additive, zero regressions) plus 14 new checks for the real-disk-identity coverage above (54 total).
  - **Commit**: `b4c4321`, pushed to `origin/work/hosted-paper-engine-impl`.
  - **CORRECTION (2026-09-18, second review fix cycle)**: the "40 pre-existing + 14 new = 54 total" count immediately above is WRONG — it was arithmetic from memory, never actually run. A second reviewer independently ran BOTH `git show a0c5ff5:src/fleet/hosted-commands.test.ts` (the pre-this-fix version, executed standalone in a temporary worktree checked out at that commit) and the post-fix (`b4c4321`) version standalone, and counted the real `✅`/`❌` output directly (`grep -c "^✅"`) rather than estimating. **Real numbers: 46 pre-existing + 15 new = 61 total** (before the second-review-fix's own new tests below — see that entry for the count after those are added). Corrected here rather than silently left wrong.

- 2026-09-18 — Task 4 SECOND REVIEW FIX. A second review pass on the `b4c4321` fix found three further real problems, none of which invalidate the first fix's core design decision (rotate-in-place) but all three needed fixing:
  - **Problem 1 (P0) — DB-write-then-disk-write ordering left a real crash window.** `convertClientToHosted` (bot.ts) and `registerHostedClient` (bot.ts) both committed the DB change(s) BEFORE writing the identity to disk. If the process died in that window, `hosting_mode` was already durably `"hosted"` (and, for `convertClientToHosted`, `device_public_key` already rotated) with NO corresponding identity file on disk. The next `/paper_start` call's `else if (client.hosting_mode !== "hosted")` guard in `startHostedEngine` would then be FALSE for that row, so `convertClientToHosted` would never run again — `spawnTenant` would be called directly against an empty runtime dir, reintroducing the exact P0 the first fix closed, just narrowed to a crash window instead of guaranteed. **Fix**: reordered both functions to disk-write-first, DB-commit-last. For `convertClientToHosted` specifically, the two separate DB statements the first fix used (`rotateClientDeviceIdentity` then `setHostingMode`) were also collapsed into ONE new atomic UPDATE, `rotateClientDeviceIdentityAndSetHosted(id, newPublicKey)` (`engine-clients.ts`) — a single Postgres statement that rotates the key and flips the mode together, so there is no intermediate "key rotated but still local" state to reason about either. **Self-healing property, verified**: traced the crash scenario where `writeHostedDeviceIdentityToDisk` succeeds but the process dies before the DB commit — the row is left with its ORIGINAL `hosting_mode`/`device_public_key` (untouched, since the DB call never ran), so a retry from `/paper_start` takes the identical `else if` branch again and re-runs `convertClientToHosted` from scratch: a fresh keypair is generated, the incomplete on-disk file from the crashed attempt is overwritten (safe — it was never referenced by any committed row), and the atomic UPDATE then commits cleanly. No leftover inconsistent state survives a retry. Also verified the disk-write-throws case (disk full/permissions): since the disk write is now the FIRST operation and is synchronous, a throw there propagates before any DB call is even attempted — the DB is provably never touched. Both properties are exercised by NEW tests in `hosted-commands.test.ts`, not just asserted: a "crash-safety" block forces a fake DB commit to throw on its first call (after the real disk write has genuinely happened via the real `generateHostedDeviceIdentity`/`writeHostedDeviceIdentityToDisk`), confirms the row is untouched, then retries and confirms the retry succeeds with a fresh key and no drift between the final on-disk identity and the final DB row; a second block confirms a thrown disk write leaves zero DB commit attempts.
  - **Problem 2 (UX gap) — no disclosure of local-pairing supersession.** The success DM sent by `handlePaperStart` on a local→hosted conversion never told the user their existing local pairing was being permanently superseded — the only way they'd find out was their local CLI silently failing to sync on its next attempt. **Fix**: `startHostedEngine` now returns a `converted: boolean` flag (true only when the `else if` branch ran — i.e. an existing LOCAL client was just converted; false for a brand-new hosted-only client, which has no prior local identity to supersede). `handlePaperStart` appends one additional sentence to the existing success DM ONLY when `converted === true`: *"Note: this replaces your existing local device pairing for this account — your local ARIA CLI will stop syncing after this. Run /pair again if you want to use the local CLI."* Kept concise and appended to the existing `✅ ... Use /paper_status to check progress.` message rather than a separate DM, matching this file's one-DM-per-command-outcome convention. New tests confirm the notice appears ONLY for the local→hosted transition — never for a brand-new hosted-only client, and never for an already-hosted client's repeat `/paper_start`.
  - **Problem 3 (ledger accuracy) — corrected above.** The `b4c4321` Log entry's "40 pre-existing + 14 new = 54 total" was never actually run; see the CORRECTION note directly above this entry for the real, independently-verified numbers (46 pre-existing + 15 new = 61 total, before this fix cycle's own new tests).
  - **Test/typecheck/regression results**: `npm run typecheck` — clean, zero errors. Full `npm test` (all 8 scripts, `fleet-manager.integration.test.ts` included) — exit 0, zero `❌` lines across the entire suite output. `fleet-manager.integration.test.ts` also run standalone on its own (`npx tsx src/fleet/fleet-manager.integration.test.ts`), against the real `aria-engine` CLI confirmed on `feat/hosted-runtime-dir-override` @ `69299df` (`git branch --show-current` + `git log -1` re-checked, plus `git pull` — already up to date) — 8/8 pass. `hosted-commands.test.ts` run standalone: **61 pre-existing (freshly re-confirmed by re-running the exact `b4c4321` version before making any change) + 29 new checks for this fix cycle (crash-safety self-healing block, disk-write-failure block, and the DM-disclosure block) = 90 total**, all passing, zero regressions — every number in this paragraph is a real `grep -c "^✅"` count on this session's own actual command output, not arithmetic from memory.
  - **Commit**: `1c66e8a` (code + this ledger entry), pushed to `origin/work/hosted-paper-engine-impl`.

- 2026-09-18 — Task 5 implemented: `src/fleet/dual-mode-coexistence.test.ts` (new), `package.json` (new test appended to `npm test`), this ledger entry.
  - **Environment precondition confirmed first**: `C:\Users\AIWMC\dev\aria-engine` was already on `feat/hosted-runtime-dir-override` @ `69299df` (`git branch --show-current`/`git log -1` checked directly), `git pull` run — already up to date.
  - **The plan's original Task 5 text predates Task 4's actual design and needed updating before a test could be written — read Task 4's full three-round Log entry first, per this task's own instructions.** The plan assumed "switching between local-CLI and hosted modes" might mean one `client_id` living under two different device identities depending on which side is running. Task 4's REVIEW FIX (rotate-in-place) and its own forward-looking note ("a future task that wants genuine local+hosted dual-running... would need a deliberate SEPARATE-row design... Task 5's 'dual-mode coexistence' is worth re-checking against this") explicitly flagged that this task needed to re-derive its scenarios from the real implementation, not the plan's original prose. Did so.
  - **Central factual finding #1 (converting local→hosted): CONFIRMED, matches Task 4's documented design exactly.** Traced `startHostedEngine` (hosted-commands.ts) → `convertClientToHosted` (bot.ts, per its docblock) → `rotateClientDeviceIdentityAndSetHosted` (engine-clients.ts): converting an existing LOCAL row to hosted rotates that SAME row's `device_public_key` to a fresh server-generated Ed25519 keypair and flips `hosting_mode` to `'hosted'` — one row, one `client_id`, throughout. The user's original local device identity for that `client_id` is permanently superseded at that moment. This is a deliberate one-way handoff (Task 4's own design decision), not a bug, and this task's test is built to prove that handoff is SAFE, not to challenge the decision itself.
  - **Central factual finding #2 (hosted→attempted local, the task's other central question): investigated directly by reading `src/bot.ts`'s `/pair` command, `src/engine-pairing.ts` (`createPairingCode`/`consumePairingCode`), and `src/server.ts`'s `POST /api/engine/pair` handler end to end — NOT assumed.** Result: `/pair`'s entire code path is scoped to `userId` only and is COMPLETELY UNAWARE of any pre-existing `engine_clients` row for that user. `createPairingCode(userId)` stores `{user_id, code_hash, expires_at}` — no `client_id`. `consumePairingCode(code)` returns only `{userId}` — again no `client_id`. `POST /api/engine/pair` takes that bare `userId` and calls `registerClient({userId, devicePublicKey, ...})` (engine-clients.ts), which is an unconditional `INSERT INTO engine_clients (...) VALUES (...)` — there is no `SELECT ... WHERE user_id = $1` check, no update-existing-row branch, and no `hosting_mode` reference anywhere in this path. **Conclusion: local and hosted are ALWAYS separate `engine_clients` rows/`client_id`s in current practice, unconditionally** — true whether the user has never paired, already has a `'local'` row, or already has a `'hosted'` row (including a rotated-in-place one from finding #1). This is NOT an artifact of Task 4's rotate-in-place choice specifically — `/pair`'s own code has zero row-reuse logic regardless of which design Task 4 had picked for local→hosted conversion. This materially simplifies what "coexistence" needs to guarantee for the hosted→local direction: there is no shared mutable identity state to corrupt, because they are simply two independent rows from the moment `/pair` completes. A real, disclosed consequence of this (not previously written down anywhere): `getLatestActiveClientForUser` (engine-clients.ts) returns exactly ONE row per user, ordered by `COALESCE(last_seen_at, paired_at) DESC` — a user who ends up with BOTH a hosted and a local row has every hosted Telegram command (`/paper_start`/`/paper_stop`/`/paper_status`) resolve to whichever row was MOST RECENTLY ACTIVE, not necessarily the hosted one. This is existing, unchanged behavior (no code was touched to produce or discover this), documented here as a real UX subtlety for whoever designs the "which client am I controlling" surface next, not treated as this task's own gap to close.
  - **Central factual finding #3 (no simultaneous double-process for one client_id): given findings #1 and #2 together, the ONLY reachable real-world configuration where two live processes are ever pointed at the exact SAME `client_id` is finding #1's own window** — an old local CLI process still holding the pre-rotation identity, racing a newly-spawned hosted process for the SAME (now-rotated) row. Finding #2 rules out the hosted→local direction ever colliding on one `client_id` at all, structurally (`/pair` always mints an independent row). Tested this window directly (see below) rather than reasoning about it abstractly, per this task's explicit instruction: **NO GAP FOUND, existing protections are sufficient and were confirmed, not assumed.** `server.ts`'s real `/api/engine/sync` handler (read directly) checks the Ed25519 signature against the row's CURRENT `device_public_key` strictly BEFORE the sequence-number advance is ever attempted (`verifyDeviceSignature` at line ~367, `atomicAdvanceSequence` at line ~376 — confirmed by reading, not assumed). Since `device_public_key` is a single column (one row has exactly one currently-valid identity at any instant), the moment a rotation commits, the OLD identity's signature simply stops verifying for every subsequent request — cleanly rejected at the auth step, and the rejected request never reaches (and therefore can never corrupt or race on) the sequence counter. No new coordination mechanism (locking, a "who's allowed to sync right now" flag, etc.) is needed on top of this — per the plan's own Step 2 instruction not to build one unless a real gap is demonstrated by a failing test, and this test demonstrates the opposite: the existing design already prevents it.
  - **Test design and why it doesn't spin up Hono + a real Postgres**: this dev worktree has no `DATABASE_URL` configured — confirmed absent, the same finding Task 2's and Task 4's own ledger entries already recorded for this exact environment (no `.env` file present). Every existing HTTP-level test in this repo (`test/engine-customer-api-contract.ts` etc.) already runs WITHOUT it and only proves routes fail closed (400/401/503) before ever reaching Postgres — a genuine end-to-end HTTP test of `/api/engine/sync` accepting/rejecting a rotated key was not achievable here without standing up a live database, which this task was not asked to do. Instead, `dual-mode-coexistence.test.ts` calls the REAL, exported, pure security primitives the actual handler uses — `canonicalSyncMessage`/`verifyDeviceSignature` from `device-auth.ts`, unmodified, and the REAL `generateHostedDeviceIdentity`/`writeHostedDeviceIdentityToDisk` from `hosted-device-identity.ts` — in the SAME order `server.ts` calls them, against a tiny in-memory table that reimplements the REAL SQL semantics of `registerClient` (INSERT-only), `rotateClientDeviceIdentityAndSetHosted` (atomic UPDATE), and `atomicAdvanceSequence` (strictly-greater-only advance). This matches this program's own established convention (Task 2's fake CLI fixture deliberately reimplements the real engine's desired-state stop protocol rather than trivializing it) instead of either skipping the test or asserting on a from-memory description of the protocol. The Fleet-Manager-side claim (spawn-side no-double-process) uses the REAL `FleetManager` class against the already-established fake CLI fixture (`test-fixtures/fake-engine.mjs`) — a genuine OS-level child process, no reimplementation needed there. The hosted process spawned in Scenario A is real (`fm.spawnTenant`, real pid, reaches `running`, stops cleanly) — only the Postgres row and the second (stale, local) "process" are simulated, and only because no live DB is available in this environment.
  - **Test coverage** (27 checks, `src/fleet/dual-mode-coexistence.test.ts`):
    - Scenario A (local→hosted): pairs locally (real identity A), converts via rotate-in-place (real identity B, real disk write, real atomic row update), spawns the REAL hosted process via `FleetManager`+fake CLI fixture and confirms it reaches `running` with a real pid; then proves the crux — a post-rotation sync attempt signed with the STALE identity A is rejected at signature verification (not at "unknown client" or any other reason), the rejected attempt does NOT advance the sequence counter, and the hosted process's own (identity B) sync for the SAME sequence number the stale attempt tried succeeds cleanly afterward with no cross-contamination.
    - Scenario B (hosted→attempted local): creates a hosted-only row, then simulates `/pair`'s real `registerClient` INSERT-only behavior for the same user — proves it produces a DIFFERENT `client_id`, leaves the hosted row completely untouched (key and mode both), and that each row syncs correctly under its own identity with a cross-identity swap between the two rejected (proving no shared key/state). Also reproduces `getLatestActiveClientForUser`'s real "most-recently-active wins" ordering rule directly (not just described in prose) to demonstrate the disclosed UX consequence of two independent rows existing for one user.
    - Scenario C (no simultaneous double-process): C1 re-confirms, in this task's own scenario terms, that `FleetManager.spawnTenant` on an already-running `client_id` returns the same handle with no second OS process (real class, real fixture, real pid comparison) — the Fleet-Manager-internal half of the guarantee. C2 states the conclusion that the ONLY reachable dual-process-on-one-`client_id` configuration is Scenario A's own window, already proven safe by Scenario A's own assertions above (referenced, not duplicated).
  - **Step 2 (per the plan): no gap found, so nothing was built.** No new coordination/locking mechanism, no schema change, no production code touched at all — only the new test file and `package.json`'s test script. Matches the plan's explicit instruction: "do not build a new coordination mechanism if the existing sequence-number replay protection already makes double-processing impossible; only add something if a real gap is demonstrated by a failing test first." No failing test was produced; the opposite was demonstrated.
  - **Test/typecheck/regression results**: `npx tsx src/fleet/dual-mode-coexistence.test.ts` standalone — 27/27 checks pass. `npm run typecheck` — clean, zero errors. Full `npm test` (now 9 scripts, this new test appended last) — exit 0, `grep -c "❌"` on the full captured output returns `0`, `grep -c "^✅"` returns `300` total across the whole suite (real count from this session's own command output, not estimated). `npx tsx src/fleet/fleet-manager.integration.test.ts` run standalone, per this task's instructions, against the real `aria-engine` CLI (branch confirmed `feat/hosted-runtime-dir-override` @ `69299df` via `git branch --show-current`/`git log -1`, `git pull` — already up to date) — 8/8 pass, zero regressions.
  - **Commit**: `e874097`, pushed to `origin/work/hosted-paper-engine-impl`.

- 2026-09-19 — Task 6 implemented: `scripts/fleet-soak.ts` (new, the load-test
  script), `scripts/fleet-soak-crashloop-fixture.mjs` (new, see below),
  `docs/FLEET_MANAGER_RUNBOOK.md` §9 (new section, full evidence), this
  ledger entry. `scripts/fleet-soak-evidence.json`/`scripts/fleet-soak-run.log`
  are the script's own generated output (not hand-authored, regenerated by
  every run — not committed as source, referenced from the runbook as the
  raw-evidence location).
  - **Environment precondition confirmed first**: `C:\Users\AIWMC\dev\aria-engine`
    was on `feat/hosted-runtime-dir-override` @ `69299df` (`git branch
    --show-current`/`git log -1` checked directly, `git pull` — already up
    to date) — matching every prior task in this program.
  - **Design**: real `FleetManager` (never a reimplementation), real
    `test-fixtures/fake-engine.mjs` (synthetic market mode, zero real RPC
    calls, per the plan's own Task 6 instruction), two phases in one script
    run so the whole soak consumes real continuous clock time: Phase 1
    warmup (N=5, 90s hold, verify clean spawn/stop/no-orphans) then Phase 2
    main soak (N=20, 30 minutes, with 2 tenants configured to crash-loop
    and 3 tenants killed directly via `process.kill(pid, "SIGKILL")` —
    bypassing `stopTenant()` entirely, the same external-kill technique
    Task 2's own isolation test used — at the 550s mark, 15 tenants left
    completely untouched as isolation controls).
  - **A real bug found IN THE SOAK SCRIPT itself during this task, fixed
    within the same session (full detail in the runbook §9, summarized
    here)**: the first full 32-minute run used a single shared
    `process.env.FAKE_CRASH_AFTER_MS`, set before the crash-loop tenants'
    initial `spawnTenant()` and cleared right after — this correctly
    crashed their FIRST run but NOT any subsequent auto-restart (which
    fires from FleetManager's own internal `setTimeout`, long after the
    soak script's spawn loop had moved on and cleared the var), so both
    crash-loop tenants crashed exactly once and then looked "recovered"
    instead of exercising the full exponential-backoff-then-give-up path
    the task explicitly asked to observe under real concurrent load. Not a
    `FleetManager` defect — Task 3's own unit tests already directly verify
    that state machine in isolation; this was purely an artifact of how the
    soak script tried to inject the fault. **Fix**:
    `scripts/fleet-soak-crashloop-fixture.mjs`, a wrapper that bakes
    `FAKE_CRASH_AFTER_MS` into every fresh process's OWN environment at
    the top of its own execution (survives any number of FleetManager
    restarts, independent of the soak script's `process.env` state), used
    by a SEPARATE `FleetManager` instance (`fmCrashLoop`, `maxConcurrentTenants:
    2`) dedicated to the 2 crash-loop tenants, while the other 18 share the
    ordinary non-crashing fixture. Verified with two short dry-runs (2–4
    min: first showed `consecutiveCrashes` correctly escalating 1→2→3→4,
    second — 150s main duration — showed the full escalation to terminal
    `failed` at `consecutiveCrashes===5`) BEFORE re-running the full
    32-minute soak with the fix.
  - **Final results (from the corrected, full 32-minute re-run — see
    runbook §9 for complete detail and methodology)**: FleetManager-hosting
    process RSS 59,356–60,424 KB and heapUsed 7,904–8,499 KB across 25
    samples over the 30-minute main-soak window (bounded oscillation, no
    growth trend, including after fault injection) — sample tenant OS RSS
    50,704–53,016 KB across all 20 tenants. 15/15 control tenants
    completely unaffected (pid/restartCount/consecutiveCrashes
    byte-identical pre/post fault injection). 3/3 SIGKILL'd tenants
    auto-recovered with NEW pids under real concurrent 20-tenant load.
    2/2 crash-loop tenants correctly reached terminal `failed` at
    `consecutiveCrashes===5`, `restartCount===4`, matching the documented
    5s/10s/20s/40s/give-up schedule. Zero cross-tenant log contamination
    across 20 tenants (`journalIntegrityIssues: []`). Zero orphaned OS
    processes after full Fleet Manager shutdown (both phases), verified
    via real `process.kill(pid,0)` liveness probes, not in-memory
    bookkeeping alone. Real elapsed: 31 minutes 47 seconds
    (`totalElapsedMs: 1906604`), aria-telegram-BOT-APP SHA
    `7e3a4da79e697bcb083bdab100e844f56fb277c7`, aria-engine
    `feat/hosted-runtime-dir-override` @ `69299df9a68d925281f181064cb84c83771698a3`.
  - **Provider degradation — honestly scoped out, not claimed**: the fake
    fixture makes zero real RPC calls of any kind, so a real
    provider-degradation scenario is not meaningfully testable at the
    Fleet-Manager layer with it. This is disclosed explicitly (runbook §9)
    rather than silently skipped, and is named as the
    reference-driven-commercialization program's own Task 10's job (a real
    or realistically-mocked RPC endpoint against a real `aria-engine`
    process), not a gap this task quietly leaves unaddressed.
  - **Verdict: GREEN.** No real defect was found in `FleetManager` itself.
    The one real defect found during this task was in the SOAK SCRIPT's own
    first attempt (described above) — fixed and re-validated within the
    same session before the certifying run. Full per-category evidence
    table in `docs/FLEET_MANAGER_RUNBOOK.md` §9.
  - **Test/typecheck/regression results**: `npm run typecheck` — clean,
    zero errors (the new `scripts/fleet-soak.ts` and
    `scripts/fleet-soak-crashloop-fixture.mjs` type-check under this repo's
    existing `tsconfig.json`, which already includes `scripts/**/*.ts`).
    Full `npm test` (all 9 existing scripts, unchanged — the soak script is
    deliberately NOT added to `npm test`, per the plan's own "not
    necessarily a permanent CI test" instruction for Task 6) — exit 0, zero
    `❌` lines, confirming the new files introduce zero regressions.
  - **Commit**: `54ca099` (code + runbook + this ledger entry); this exact
    SHA recorded in a small follow-up ledger-only commit, matching this
    program's own established two-commit pattern (Tasks 3/4).
  - **2026-09-19 — RE-CERTIFICATION after independent-review FAIL (status
    stays `IMPLEMENTED (awaiting review)` — a fresh independent review of
    THIS fix still needs to happen).** An independent reviewer failed the
    soak above (commits `54ca099`, `d66848a`) on three findings, all in
    this soak SCRIPT's own evidence-gathering logic, none in `FleetManager`
    itself:
    - **P0-1**: the log cross-contamination check was structurally
      vacuous — it looked for another tenant's `clientId` string inside a
      log, but nothing ever wrote a `clientId` into any log, so it could
      never fire (all 20 tenants' logs were byte-identical fixture
      boilerplate). **Fix**: every tenant now gets a genuinely distinctive
      marker (`SOAK-MARKER::<clientId>::END`) baked into `argv` via a
      dedicated `FleetManager` instance per tenant (`markerInvocation()`/
      `crashLoopMarkerInvocation()`, new fixture files
      `scripts/fleet-soak-marker-fixture.mjs` and
      `scripts/fleet-soak-crashloop-marker-fixture.mjs` — the original
      `scripts/fleet-soak-crashloop-fixture.mjs` is untouched, already
      independently verified) — survives every restart, not just the
      first run. Added a ready-marker-COUNT check per tenant (control=1,
      SIGKILL-recovered=2, crash-loop-to-terminal=5) that independently
      confirms each tenant's restart-path lifecycle.
    - **P0-2**: the "control tenant unaffected" check was pure in-memory
      bookkeeping (`getTenantStatus()` field comparison only), no OS-level
      probe — would pass even if the isolation logic itself were broken
      but happened to report identical-looking numbers. **Fix**: reused
      the script's existing `isPidAlive()` (already used for the
      shutdown-orphan check) to confirm each control tenant's pid is
      genuinely the SAME OS process across the fault-injection window,
      plus a real `fs.statSync()` size/mtime diff on each control tenant's
      log file across that same window.
    - **P1-3**: the tenant-count claim ("20 concurrent tenants sustained
      for 30 minutes") was overstated — the evidence JSON itself showed
      `activeTenantCount` dropping from 20 to 18 by t≈75-160s (the 2
      crash-loop tenants correctly reaching terminal `failed` early, by
      design) and staying at 18 for the rest of the run. **Fix**: every
      claim (runbook prose, script comments, this entry) now says "20
      tenants spawned; 18 sustained concurrently," computed directly from
      `memSamples`, not asserted.
    - **A fourth, real bug found DURING this fix itself** (disclosed, not
      silently patched): the first version of the new marker,
      `SOAK-MARKER::<clientId>` with no closing delimiter, is unbounded on
      the right — `SOAK-MARKER::soak-main-1` is a literal PREFIX of
      `SOAK-MARKER::soak-main-10`..`-19`. Invisible in every small dry-run
      (never reached two-digit indices); produced 10 false-positive
      "contamination" findings on the first full N=20 re-run. **Fix**:
      closed the marker with a trailing `::END`
      (`SOAK-MARKER::<clientId>::END`) so no marker can be a substring of
      another's. Re-verified at N=20 scale (short duration, zero false
      positives) before re-running the full 30-minute soak.
    - **Both new checks empirically proven able to fail, not just verified
      to pass**: a dry-run with all markers deliberately collided produced
      25 real cross-contamination findings; a separate dry-run that also
      SIGKILLed one "control" tenant (simulating an isolation breach)
      correctly flipped `pidStillAliveSamePid` to `false` for that tenant
      and the aggregate isolation check to `false`. Both temporary breaks
      reverted before the certifying run.
    - **New certified results** (full re-run, real numbers, supersede the
      first soak's wherever they differ — full detail in runbook §9):
      FleetManager-hosting process RSS 56,976–61,360 KB, heapUsed
      8,166–8,946 KB across 27 samples over the ~30-minute main-soak
      window. **20 tenants spawned; 18 sustained concurrently from
      t≈74s to t≈1812s (≈29.0 minutes) after the 2 crash-loop tenants
      reached terminal `failed` by design.** 15/15 control tenants
      unaffected by BOTH in-memory bookkeeping AND the new OS-level
      pid-liveness + log-file-unchanged checks. Zero cross-tenant
      log-marker contamination (`journalIntegrityIssues: []`) on a check
      now proven capable of firing. All 20 tenants' ready-marker counts
      exactly match their expected lifecycle (control=1×15,
      SIGKILL-recovered=2×3, crash-loop=5×2) — zero restart-path
      mismatches. 3/3 SIGKILL'd tenants (`soak-main-2/3/4`) auto-recovered
      with new pids (`consecutiveCrashes: 1`, `restartCount: 1` each).
      2/2 crash-loop tenants (`soak-main-0/1`) correctly reached terminal
      `failed` (`consecutiveCrashes: 5`, `restartCount: 4` each). Zero
      orphaned OS processes after full shutdown (both phases). Real
      elapsed: 32 minutes 59 seconds (`totalElapsedMs: 1919280`;
      main-soak phase alone `totalElapsedMs: 1812266`), aria-telegram-BOT-APP
      SHA `d66848a498cb7f0f7bf27d1d407469a359211fb3` at soak start,
      aria-engine unchanged at `feat/hosted-runtime-dir-override` @
      `69299df9a68d925281f181064cb84c83771698a3`.
    - **New disclosure added (runbook §9)**: this soak (both runs) executed
      on Windows (`tasklist` for RSS sampling, `process.kill(pid,
      "SIGKILL")` mapping to Windows `TerminateProcess()` semantics), while
      production targets Railway/Linux. Stated plainly: this soak certifies
      `FleetManager`'s own platform-independent state-machine/isolation
      logic, NOT Linux-specific process/signal behavior (real POSIX
      `SIGKILL` delivery, cgroup/OOM interaction, Linux zombie-reaping
      edge cases) — a real, disclosed gap, not assumed identical.
    - **Verdict: GREEN, unchanged** — no real `FleetManager` defect was
      found by either the first soak or this re-certification; every
      defect found (the original crash-loop timing bug, this
      re-certification's own vacuous checks, and its own marker
      prefix-collision bug) was in this task's OWN tooling, disclosed and
      fixed within the same session each time, not in the class under
      test.
    - **Test/typecheck/regression results**: `npm run typecheck` — clean,
      zero errors. Full `npm test` (unchanged, 9 scripts) — exit 0, zero
      `❌` lines.
    - **Status stays `IMPLEMENTED (awaiting review)`** — this fix has not
      yet had its own independent review; do not mark Task 6 fully
      reviewed-pass until that happens.
  - **2026-09-19 — SECOND RE-CERTIFICATION after a second independent-review
    FAIL (status stays `IMPLEMENTED (awaiting review)` — a THIRD
    independent review of THIS fix still needs to happen).** A second
    independent reviewer failed the first re-certification fix above
    (commits `1123008`/`5f92185`) on one finding, and it invalidated the
    fix's own central design decision, not just a peripheral detail:
    - **The finding**: to make each tenant's marker survive every
      FleetManager-internal auto-restart, the first fix gave each tenant a
      distinct `EngineInvocation` closure (baking the marker into argv),
      and because `EngineInvocation` is configured once per `FleetManager`
      instance rather than per spawn call, that required **20 separate
      `FleetManager` instances** (`scripts/fleet-soak.ts:387-393` in that
      commit) — one per tenant, each `maxConcurrentTenants: 1`. But
      `FleetManager` keeps ALL cross-tenant bookkeeping in a private
      per-instance `Map` (`src/fleet/fleet-manager.ts:159`). With 20
      separate instances, a control tenant and a crash-looping/SIGKILLed
      tenant shared NO state — so the in-memory half of the isolation
      check could no longer detect the exact bug class it exists to catch
      (a shared-Map/restart-scheduler defect where handling tenant A's
      crash perturbs tenant B's bookkeeping). The reviewer proved this was
      structurally unreachable, not just theoretically weaker: only the
      OS-level probe (an externally-injected kill the reviewer performed
      manually) remained capable of detecting anything under that
      topology.
    - **The reviewer also proved the per-instance split was never
      necessary.** `FleetManager.launch()` already computes
      `runtimeDirFor(clientId) = path.join(tenantsRoot, clientId, ".aria")`
      and `TenantProcess` sets this exact path as `ARIA_RUNTIME_DIR` on
      EVERY launch it performs for that tenant, initial or restart
      (`src/fleet/tenant-process.ts:68`), regardless of how many
      `FleetManager` instances exist. A marker fixture can read
      `process.env.ARIA_RUNTIME_DIR` and derive
      `path.basename(path.dirname(ARIA_RUNTIME_DIR))` as its own clientId —
      zero need for a per-tenant closure, therefore zero need for a
      per-tenant instance.
    - **Fix applied**:
      1. `scripts/fleet-soak.ts`'s main-soak phase now uses ONE shared
         `FleetManager` instance for all 20 tenants, `maxConcurrentTenants:
         20` genuinely engaged — restoring the original, first-reviewed
         topology from commit `54ca099`.
      2. The three per-purpose fixture files
         (`fleet-soak-marker-fixture.mjs`,
         `fleet-soak-crashloop-marker-fixture.mjs`,
         `fleet-soak-crashloop-fixture.mjs`) were deleted and replaced with
         ONE shared fixture, `scripts/fleet-soak-fixture.mjs`, used by
         every main-soak tenant. It derives its marker from
         `process.env.ARIA_RUNTIME_DIR` (via
         `path.basename(path.dirname(...))`) and decides crash-loop
         behavior purely from its own clientId's naming convention
         (`soak-crashloop-*`, assigned by the soak script) — no argv
         parameter needed. The `::END` marker-delimiter fix from the FIRST
         re-certification cycle (closes the unbounded-prefix collision
         risk at two-digit tenant indices) is unchanged and still
         load-bearing.
      3. Corrected the three places that asserted a per-tenant
         `FleetManager` instance was REQUIRED for the marker mechanism —
         this claim was factually wrong: `scripts/fleet-soak.ts`'s own
         comments (rewritten to explain why ONE shared instance is correct
         instead), `docs/FLEET_MANAGER_RUNBOOK.md` §9 (rewritten wholesale
         for this cycle — see below), and this ledger (this entry
         supersedes the prior cycle's now-incorrect topology claims,
         though that entry is left in place above as the historical record
         of what was tried and why it was later found wrong).
      4. **Re-verified empirically, before the full run**, that both
         isolation channels are genuinely exercised again under the
         restored shared topology (ad hoc verification script, not
         committed — output transcribed here and in the runbook since it
         is evidence about the mechanism): two tenants spawned under ONE
         shared instance showed zero cross-contamination in the clean
         case; a marker COLLISION was then deliberately injected into one
         tenant's log and confirmed the real contamination check's
         `content.includes(otherMarker)` logic correctly evaluates `true`
         against it (proving the check CAN fire, not just that it hadn't);
         reverted. Separately, a control tenant sharing the SAME
         `FleetManager` instance as an untouched sibling was SIGKILLed
         directly — confirmed BOTH channels caught it independently:
         in-memory (`getTenantStatus()` transitioned `running` → `crashed`,
         proving the SHARED bookkeeping Map actually observed the kill —
         the exact channel the second review found unreachable under the
         20-instance topology) and OS-level (`process.kill(pid, 0)`
         confirmed the original pid was gone); the killed tenant then
         auto-recovered with a new pid via the normal backoff path, and
         the untouched sibling's status/pid were completely unaffected
         throughout.
      5. **Ran the full soak** (N=5 warmup, N=20 main phase, real fault
         injection: 3 tenants SIGKILLed directly at t≈535s, 2 tenants
         driven into crash-loop escalation, all under the restored ONE
         shared `FleetManager` instance with `maxConcurrentTenants: 20`
         genuinely engaged) and regenerated
         `scripts/fleet-soak-evidence.json` from this real run — the prior
         evidence file had already been overwritten by the second
         reviewer's own break-testing runs, so this is fresh real data.
    - **New real evidence from this run** (full detail, all real numbers
      not estimated, in `docs/FLEET_MANAGER_RUNBOOK.md` §9): started
      `2026-09-19T18:41:10.422Z`, finished `2026-09-19T19:13:26.017Z`,
      total elapsed `1935445ms` (≈32m15s); main-soak phase alone
      `1819930ms` (≈30.3 min). `aria-telegram-BOT-APP` SHA
      `5f9218585b44e18e65a0c04336b6db0e739849f5` at soak start; `aria-engine`
      unchanged at `feat/hosted-runtime-dir-override` @
      `69299df9a68d925281f181064cb84c83771698a3`. Phase 1 warmup: all 5
      reached running, all 5 stayed running/OS-alive through the 90s hold,
      all 5 stopped cleanly, zero orphaned pids. Phase 2: 20 tenants
      spawned under the ONE shared instance; `allNonCrashLoopReachedRunning:
      true`. FleetManager-hosting process RSS ranged 60,872–61,736 KB,
      heapUsed 7,956–8,555 KB across 25 samples (no growth trend, including
      through fault injection). **20 spawned; 18 sustained concurrently
      from t≈79s to t≈1820s (≈29.0 minutes)** after the 2 crash-loop
      tenants reached terminal `failed` by design — computed directly from
      `memSamples`. Tenant isolation: `controlTenantsCompletelyUnaffected:
      true` (`controlTenantsCompletelyUnaffectedInMemory: true` AND all 15
      `controlTenantsOsLevelChecks` entries pass — pid-still-alive-same-pid
      AND log-file-unchanged, both real OS-level probes, for every control
      tenant). Zero cross-tenant log-marker contamination
      (`journalIntegrityIssues: []`) on a check independently proven able
      to fire (see item 4 above). All 20 tenants' ready-marker counts
      exactly match expected lifecycle (control=1×15, SIGKILL-recovered=
      2×3, crash-loop=5×2) — zero restart-path mismatches. 3/3 SIGKILL'd
      tenants (`soak-sigkill-0/1/2`) auto-recovered with new pids
      (`consecutiveCrashes: 1`, `restartCount: 1` each). 2/2 crash-loop
      tenants (`soak-crashloop-0/1`) correctly reached terminal `failed`
      (`consecutiveCrashes: 5`, `restartCount: 4` each). Zero orphaned OS
      processes after full shutdown (both phases).
    - **Framing correction, per the second reviewer's specific note that
      "GREEN" language in the prior cycle's summary table invited an
      inference the evidence didn't support**: the runbook's §9 summary
      table for this cycle states what each row's evidence actually shows
      (e.g. "15/15 control tenants' status/pid/restartCount/
      consecutiveCrashes bit-for-bit unchanged... under a topology where
      all 20 tenants share ONE FleetManager instance's bookkeeping Map")
      rather than appending a bare "GREEN"/pass-fail word, and the section
      opens with an explicit caveat that this evidence has not yet been
      independently reviewed and that passing checks on one run do not
      constitute a general defect-free guarantee. No `FleetManager` defect
      was found on this run — every defect found across this program's
      three soak cycles to date (the original crash-loop timing bug, the
      first re-certification's vacuous checks and marker-prefix-collision
      bug, and this cycle's per-instance-topology defect) was in this
      task's OWN tooling, not in `FleetManager` itself — stated as an
      observation about this tooling's history, not a general
      defect-free claim.
    - **Test/typecheck/regression results**: `npm run typecheck` — clean,
      zero errors. Full `npm test` (unchanged, 9 scripts) — exit 0, zero
      `❌` markers, 300 `✅` lines.
    - **Status stays `IMPLEMENTED (awaiting review)`** — a THIRD
      independent review of this fix still needs to happen before Task 6
      can be marked reviewed-pass.
    - **Commit**: `ed1db8c` (code + runbook + this ledger entry); this
      exact SHA recorded in a small follow-up ledger-only commit, matching
      this program's own established two-commit pattern.

- 2026-09-19 — **P0 fix: hosted pairing-state + entitlement seeding**
  (branch `fix/hosted-pairing-state-seeding` off `work/hosted-paper-engine-impl`).
  Discovered during the engine-packaging work, not tied to a single plan
  task number — filed as its own row above.
  - **The gap, confirmed by reading the real code first**: aria-engine's
    `cmdPaperStart` (`src/cli.ts`) hard-requires, before doing anything
    else: (1) `loadPairingState()` (`pairing-state.ts`) finding a real
    `state/pairing-state.json` in the runtime dir, and (2)
    `checkPaperStartEntitlement()` (`entitlement-gate.ts`) verifying an
    Ed25519-signed ARIAE1 token — read from that SAME file's
    `entitlementToken` field — against the public key baked into the
    engine binary. `registerHostedClient`/`convertClientToHosted`
    (`src/bot.ts`) already seed `state/device-identity.json` into a
    tenant's runtime dir (Task 4), but neither ever wrote
    `pairing-state.json` or minted an entitlement token. Confirmed
    empirically, not just by reading code: ran the REAL aria-engine CLI
    (`ARIA_RUNTIME_DIR` pointed at an unseeded tenant dir) and reproduced
    the exact failure — "Device is not paired. Run `aria pair <CODE>`
    first." — before writing any fix. This meant a real hosted
    `/paper_start` from Telegram would fail closed for EVERY hosted
    tenant, independent of engine packaging or Fleet Manager correctness —
    a P0 blocking the entire hosted-PAPER product, not a cosmetic gap.
  - **Fix, reusing rather than duplicating the existing mechanism**: new
    `src/fleet/hosted-pairing-seed.ts`. `buildHostedPairingState(clientId)`
    is pure — it imports and calls `engine-entitlement-signer.ts`'s real
    `issueReal1BetaEntitlementToken` directly (the SAME function
    `server.ts`'s `/api/engine/pair` handler already calls for a
    locally-paired device; the signing key never leaves that one file
    either way) and returns `{ clientId, lastSequence: 0, entitlementToken
    }` — byte-for-byte the same shape `pairDevice`
    (aria-engine's `pairing-client.ts`) writes via `savePairingState` for a
    real `aria pair <CODE>` handshake. `writeHostedPairingStateToDisk`
    writes it to `<runtimeDir>/state/pairing-state.json` — the exact path
    `loadPairingState()` reads via `DEFAULT_KEYSTORE_DIR`
    (`runtime/paths.ts`'s `STATE_DIR`, which itself honors the
    `ARIA_RUNTIME_DIR` override the Fleet Manager already sets on the
    spawned child — the same override Task 1 built and the same `state/`
    directory `writeHostedDeviceIdentityToDisk` already writes
    `device-identity.json` into). `seedHostedPairingState` composes both
    and is the one function callers need.
  - **Wiring**: both `registerHostedClient` and `convertClientToHosted`
    (`src/bot.ts`) now call `seedHostedPairingState(runtimeDir, clientId)`
    immediately after `writeHostedDeviceIdentityToDisk`, still strictly
    BEFORE the DB commit that depends on it (`setHostingMode` /
    `rotateClientDeviceIdentityAndSetHosted`) — same write-before-commit
    crash-safety discipline Task 4's two review-fix cycles already
    established for device identity, extended to cover this second disk
    write with no new commit boundary introduced. If
    `seedHostedPairingState` throws (disk full, permissions, or an
    unexpected error not already caught by
    `buildHostedPairingState`'s best-effort issuance try/catch), the
    caller throws before touching the DB — a retry re-runs the whole
    provisioning step from scratch, exactly like the existing
    device-identity crash-safety story.
  - **Disclosed, narrower gap NOT addressed by this fix** (see
    `hosted-pairing-seed.ts`'s own docblock for the full writeup): the real
    `/api/engine/pair` flow also creates a server-side `engine_entitlements`
    DB row (`getOrCreateTrialEntitlement`) that `/api/engine/sync` reads to
    populate `entitlementStatus` on every sync response — the channel
    `lastKnownEntitlementStatus` and REAL-1 blocker #3's
    revocation-before-natural-expiry enforcement depend on. A hosted
    tenant seeded only by this fix has a valid, offline-verifiable 7-day
    token (closing the P0 — `checkPaperStartEntitlement` genuinely grants
    access) but no `engine_entitlements` row, so a server-side revocation
    issued before that token's natural expiry would not yet propagate to
    it via sync. Left as a disclosed follow-up, not silently expanded into
    this fix's scope.
  - **Tests** (`src/fleet/hosted-pairing-seed.test.ts`, new; wired into
    `package.json`'s `test` script): 40 checks, all passing. Strongest
    available proof used throughout — dynamically imports aria-engine's
    OWN real `pairing-state.ts`/`entitlement.ts`/`entitlement-gate.ts`
    modules from the sibling checkout (skips gracefully if that checkout
    isn't present, matching `fleet-manager.integration.test.ts`'s own
    convention) rather than re-implementing their logic as test
    assertions:
      1. `loadPairingState()` (the REAL aria-engine parser) successfully
         loads the file this module writes and every field round-trips.
      2. `verifyEntitlement()` (the REAL aria-engine offline verifier)
         GRANTS the token this module mints, using a synthetic Ed25519
         keypair this test controls (the production
         `ARIA_ENTITLEMENT_PRIVATE_D` lives only in Railway, by design —
         confirmed absent from this dev checkout, same as
         `fleet-manager.integration.test.ts` already documents) — plus two
         negative controls (a tampered signature is rejected; verifying
         against the WRONG public key is rejected) proving this is
         genuine signature verification, not a shape/stub check.
      3. `checkPaperStartEntitlement()` (the REAL gate `cmdPaperStart`
         itself calls) grants access given exactly what this module seeds.
      4. Crash-safety: a simulated DB-commit throw AFTER both disk writes
         (mirroring `convertClientToHosted`'s real ordering) leaves the
         row untouched and the orphaned files provably real but
         uncommitted; a retry self-heals with a fresh keypair/token and no
         drift between the final on-disk state and the committed row.
      5. A disk-write failure specifically at the pairing-state step
         (identity write already succeeded) never reaches the DB commit.
      6. Both call sites — brand-new hosted client AND local-to-hosted
         conversion — are covered, not just one.
  - **Real end-to-end proof against the actual aria-engine CLI binary**
    (attempted seriously per the task's instruction, not skipped for the
    weaker unit-test-only fallback): seeded a real tenant runtime dir
    using this fix's own functions (synthetic entitlement keypair, same
    reason as the unit tests), then ran the REAL aria-engine CLI
    (`ARIA_RUNTIME_DIR` pointed at that dir): `npx tsx src/cli.ts paper
    start` from `C:\Users\AIWMC\dev\aria-engine`. Result: "Entitlement
    signature-invalid — run `aria pair <CODE>` to obtain a fresh
    entitlement." — the pairing gate (`loadPairingState()`) is CLEARED
    (no longer "Device is not paired"); the run fails only at the
    entitlement-signature check, and only because this dev environment
    signs with a synthetic test key rather than the real production
    `ARIA_ENTITLEMENT_PRIVATE_D` (which exists solely in Railway, by
    design — see `fleet-manager.integration.test.ts`'s docblock for why
    that's correct and not a gap in this proof). Re-ran the SAME CLI
    command against a deliberately unseeded runtime dir as a control:
    reproduced the exact original P0 failure ("Device is not paired"),
    confirming the difference is genuinely caused by this fix, not an
    environment quirk. This is the strongest proof achievable without the
    real production signing key, which by design never leaves Railway.
  - **Test/typecheck/regression results**: `npm run typecheck` — clean,
    zero errors. Full `npm test` (10 scripts, the new one appended) —
    exit 0, zero FAIL markers, 345 PASS lines total, including all
    pre-existing hosted-commands/fleet-manager/dual-mode-coexistence tests
    unchanged and still passing (no regression).
  - **Status**: `IMPLEMENTED (awaiting review)` — an independent review of
    this fix has not yet happened.
  - **Commit**: `ce0e48d` on branch `fix/hosted-pairing-state-seeding`
    (code + tests + this ledger entry); exact SHA recorded here in a
    small follow-up ledger-only commit, matching this program's own
    established two-commit pattern. Branch pushed to
    `origin/fix/hosted-pairing-state-seeding`, not merged anywhere.

- 2026-09-19 — **INDEPENDENT ADVERSARIAL REVIEW of the P0 hosted
  pairing-state/entitlement seeding fix (`ce0e48d` / `977d379`): VERDICT
  PASS.** Reviewer did not write the code; every claim below was verified
  by reading the real source and re-running the real commands, not by
  trusting the implementer's self-report.
  - **Genuine reuse, not a second signing implementation (the most
    important check)**: `src/fleet/hosted-pairing-seed.ts:4` imports
    `issueReal1BetaEntitlementToken` from `../engine-entitlement-signer.js`
    and calls it at line 101. No Ed25519 signing, key handling, or token
    assembly is reimplemented anywhere in the new module — it is the
    identical function `server.ts:302` (`/api/engine/pair`) already calls
    for a locally-paired device. No drift risk from a duplicate signer.
  - **Private-key handling**: the only reader of
    `ARIA_ENTITLEMENT_PRIVATE_D` remains `engine-entitlement-signer.ts`'s
    `requireSigningKey()` (via `CONFIG`). The new module never touches it,
    never logs it, and never writes it to disk beside the token it mints.
    No hardcoded key anywhere. Confirmed no `.env` file exists in this
    worktree at all — only `.env.example`, with the key line blank —
    matching the established pattern from earlier in this program.
    `bot.ts` discards `seedHostedPairingState`'s return value, so the
    minted bearer token is never logged either.
  - **The token is real, verified by the real verifier**: the test's
    `importEngineModule()` (`hosted-pairing-seed.test.ts:75-77`) resolves
    `pathToFileURL(path.join("C:\\Users\\AIWMC\\dev\\aria-engine", "src",
    ...))` — a genuine dynamic import of the sibling aria-engine
    checkout's own `pairing-state.ts` / `entitlement.ts` /
    `entitlement-gate.ts`, not a local mock or similarly-named stub.
    Reviewer confirmed those three files are the real engine modules on
    `aria-engine` `main` @ `766dcdb`, that `checkPaperStartEntitlement`'s
    `publicKeyX` third parameter is a legitimate pre-existing
    test-injection point defaulting to the baked-in production constant
    (`entitlement-public-key.ts`), and re-ran the suite: both negative
    controls — tampered signature rejected, wrong public key rejected —
    genuinely pass, proving real Ed25519 verification, not a shape check.
  - **End-to-end CLI proof independently REPRODUCED**: reviewer seeded a
    fresh tenant runtime dir using this fix's own `seedHostedPairingState`
    under a self-generated synthetic entitlement keypair, then ran the real
    engine (`node --import tsx src/cli.ts paper start` from
    `C:\Users\AIWMC\dev\aria-engine`, `ARIA_RUNTIME_DIR` pointed at it).
    Control (unseeded dir): "Device is not paired. Run `aria pair <CODE>`
    first." Seeded dir: "Entitlement signature-invalid — run `aria pair
    <CODE>` to obtain a fresh entitlement." Exactly the implementer's
    claimed outcome, reproduced independently. That failure mode is
    internally consistent and is NOT papering over a defect:
    `signature-invalid` is specifically what `verifyEntitlement` returns
    for a well-formed, correctly-scoped, unexpired ARIAE1 token whose
    signer key does not match the engine's baked-in public key — a
    malformed payload, wrong scope, or bad TTL would surface as
    `malformed` / `expired` instead. The real production
    `ARIA_ENTITLEMENT_PRIVATE_D` correctly exists only in Railway, so this
    is the strongest proof obtainable in this environment.
  - **Write-before-commit ordering traced in BOTH call sites**, in the code
    itself rather than from a comment: `registerHostedClient` (`src/bot.ts`)
    runs `writeHostedDeviceIdentityToDisk(runtimeDir, identity)`, then
    `seedHostedPairingState(runtimeDir, client.id)`, then
    `await setHostingMode(client.id, "hosted")`; `convertClientToHosted`
    runs the same two synchronous disk writes, then
    `await rotateClientDeviceIdentityAndSetHosted(...)`. Both seeding calls
    are unconditional and strictly precede the DB commit; both are
    synchronous, so a throw provably prevents the DB call from running.
  - **Crash-safety / idempotency**: verified the test's crash block is a
    real second execution (two commit attempts counted, fresh keypair on
    the retry, final on-disk `pairing-state.json` and `device-identity.json`
    asserted to agree with the committed row), not an assertion of intent.
    Separately traced that double-seeding cannot corrupt a live tenant:
    `startHostedEngine` reaches `registerHostedClient` only when no client
    row exists, and `convertClientToHosted` only when
    `hosting_mode !== "hosted"`, so an already-hosted tenant is never
    re-seeded. The `lastSequence: 0` reset on a local-to-hosted conversion
    was checked as a possible desync defect and is NOT one: the control
    plane returns its authoritative `currentSequence` on a 409 and the
    engine's `resyncSequence` retry path (`cli.ts`, `pairing-client.ts`)
    self-heals on the first sync.
  - **File modes**: `writeHostedPairingStateToDisk` uses
    `mkdirSync(..., { mode: 0o700 })` and
    `writeFileSync(..., { mode: 0o600 })` — identical to aria-engine's own
    `savePairingState` and to this repo's `writeHostedDeviceIdentityToDisk`.
    Matches the established sensitive-tenant-file pattern.
  - **Regression check re-run by the reviewer, not taken on report**:
    `npm run typecheck` clean (zero errors); `npm test` exit 0 with
    **345 PASS lines and zero FAIL markers**, matching the claimed 345/0
    exactly, with `hosted-commands`, `fleet-manager`,
    `fleet-manager.integration`, and `dual-mode-coexistence` all unchanged
    and green.
  - **Call on the disclosed revocation-propagation gap: REAL, ACCEPTED
    AS-IS FOR MERGE, but a REQUIRED FOLLOW-UP before wider rollout.**
    Confirmed real, and in fact slightly BROADER than described:
    `getOrCreateTrialEntitlement` is called from exactly one place in the
    codebase (`server.ts:296`, inside `/api/engine/pair`), so a hosted-only
    tenant that never ran `/pair` has no `engine_entitlements` row at all —
    meaning there is not merely "no propagation", there is no entitlement
    UUID for `/revokeengine` to act on in the first place. Severity is
    nonetheless acceptable now, for reasons specific to hosted: (a)
    PAPER-only — no wallet, no signing, no money at risk; (b)
    `engine_clients.status = 'revoked'` still exists and immediately 401s
    that device's `/api/engine/sync`; (c) decisively, a hosted tenant runs
    as ARIA's OWN supervised child process, so the operator's
    `stopTenant` / kill is a strictly stronger and immediate revocation
    lever than any token channel. Worst case is bounded at 7 days of
    paper-only activity for an operator who declines to use those levers.
    The follow-up should create the `engine_entitlements` row for hosted
    tenants too, so one revocation path covers both modes.
  - **Additional finding, NOT a blocker, NOT previously disclosed — 7-day
    token TTL with no renewal path for hosted tenants.** The seeded token
    carries `REAL1_BETA_DURATION_SECONDS` (7 days) and is minted exactly
    once, at client creation/conversion. `startHostedEngine` never
    re-seeds an already-`hosted` row, so on day 8 every `/paper_start` and
    every Fleet Manager auto-restart fails the entitlement gate; the tenant
    crash-loops into `failed` while the user sees only a generic "Could not
    start your hosted PAPER engine", and the engine's own message tells
    them to run `aria pair <CODE>` — an instruction a Telegram-only hosted
    user cannot follow. This fails CLOSED (the safe direction) and is a
    usability/operability defect, not a trust-boundary defect, so it does
    not block merge. It should be fixed in the same follow-up as the
    revocation gap: renew or re-seed the token on hosted start when the
    existing one is near or past expiry, and surface a clear
    entitlement-expired message instead of a generic start failure.
  - **Minor, acceptable**: the new tests exercise
    `registerHostedClient` / `convertClientToHosted` as faithful local
    simulations rather than importing bot.ts's real functions (bot.ts
    constructs a live grammy bot at import time). The reviewer compensated
    by tracing the real ordering directly in the `ce0e48d` diff, which
    matches the simulated ordering exactly. Consistent with this repo's
    existing convention.
  - **Status**: `REVIEWED-PASS`. Ledger-only update; no code was changed by
    this review. Branch not merged, not rebased, not pushed beyond this
    ledger commit.

- 2026-09-19 — **P0-follow-up implemented: hosted entitlement-token renewal
  (`fix/hosted-entitlement-renewal`, branched off `fix/hosted-pairing-state-seeding`).**
  Closes the "NEW, undisclosed" finding from the P0 row's own review above:
  `seedHostedPairingState` mints a real ARIAE1 token exactly ONCE, with a
  fixed 7-day TTL (`REAL1_BETA_DURATION_SECONDS`, confirmed by reading
  `engine-entitlement-signer.ts:20` directly), and nothing ever re-seeds an
  already-`hosted` client. Left as-is, every hosted tenant older than 7 days
  would permanently fail the entitlement gate on its next `/paper_start` or
  FleetManager auto-restart, crash-looping to terminal `failed` with a
  denial message ("run `aria pair <CODE>`") a Telegram-only hosted user has
  no way to follow.
  - **The gap this closes**: `src/fleet/hosted-pairing-seed.ts` gains four
    new exports — `decodeEntitlementExpiry` (pure, decodes just the `exp`
    field of an ARIAE1 token without verifying its signature — renewal-need
    decisions don't require cryptographic trust, and erring toward "can't
    tell, so renew" on anything unparseable is the safe direction),
    `entitlementNeedsRenewal` (pure, true when a token is missing/
    malformed/expired/expiring within `ENTITLEMENT_RENEWAL_MARGIN_SECONDS`
    = 24h), `readHostedPairingStateFromDisk` (reads pairing-state.json back
    off disk, `undefined` on missing/corrupt rather than throwing — a
    corrupt file self-heals via re-seed instead of crashing), and
    `renewHostedPairingStateIfNeeded` (the actual fix: re-issues the token
    via the SAME `issueReal1BetaEntitlementToken` call `seedHostedPairingState`
    already uses — no second signer — and rewrites the file via the SAME
    `writeHostedPairingStateToDisk`, so the 0o600/0o700 modes and
    write-semantics are identical, not reimplemented). Unlike
    `seedHostedPairingState` (always `lastSequence: 0`, correct for a fresh
    pair/hosted-create), the renewal path PRESERVES `lastSequence` and
    `clientId` from whatever's already on disk — this is a token refresh
    for a client that may have already been running and synced past 0, not
    a re-pair.
  - **Trigger condition implemented, and why**: `startHostedEngine`
    (hosted-commands.ts) now calls a new injected dep,
    `renewHostedEntitlementIfNeeded(clientId)`, at the START of every call —
    unconditionally, for the newly-created, newly-converted, AND
    already-hosted branches alike — BEFORE `fleetManager.spawnTenant()`.
    Wired in `bot.ts` to `renewHostedPairingStateIfNeeded(tenantRuntimeDir(clientId),
    clientId)`. The 24h margin (`ENTITLEMENT_RENEWAL_MARGIN_SECONDS`) was
    chosen to comfortably exceed any realistic gap between a hosted
    tenant's `/paper_start` calls (a dormant user, a bot restart, a
    Telegram delivery delay) while staying small relative to the 7-day TTL,
    so a tenant that checks in every day or two is never needlessly
    re-signed. Calling it for EVERY branch (not just "already hosted") is
    deliberately redundant-but-cheap: a freshly (re)seeded token from
    `registerHostedClient`/`convertClientToHosted` is nowhere near the 24h
    margin, so the renewal check is a genuine, verified no-op there (see
    tests below) — one call site, no special-casing which branch needs it.
  - **Mid-session renewal — investigated, NOT needed, evidence recorded
    rather than assumed**: read aria-engine's `cli.ts` directly and
    confirmed `checkPaperStartEntitlement` is called EXACTLY ONCE, at the
    top of `cmdPaperStart`, before the tick loop starts (`cli.ts:451-458`).
    Also checked `sync/command-handler.ts`'s `refresh_entitlement` case
    (line 47-52): it only refreshes `lastKnownEntitlementStatus` (the
    SEPARATE server-revocation cache `checkPaperStartEntitlement` also
    consults), never re-runs the offline signature/expiry check itself.
    Conclusion: a token valid at process-start time remains sufficient for
    the entire run, however long it lasts — so renewing at spawn time
    (which covers both a fresh `/paper_start` AND a FleetManager
    auto-restart, since `launch()`'s restart path re-invokes the same
    `runtimeDirFor`-rooted directory `startHostedEngine` already renewed
    before the FIRST spawn) is sufficient. No mid-session renewal loop was
    built, because none is needed — a long-running tenant that's still
    inside its already-validated-at-startup token never re-checks it, and
    a tenant that crashes and auto-restarts goes back through
    `spawnTenant()`, but NOT back through `startHostedEngine`'s renewal
    call (FleetManager's own `launch()` restart path is internal, not a
    fresh `/paper_start`) — see the one disclosed residual gap below.
  - **Disclosed residual gap, not fixed in this branch, narrower than the
    original P0**: a FleetManager-internal auto-restart (crash-loop
    backoff, `fleet-manager.ts`'s `launch(entry, isRestart=true)`) calls
    `this.launch()` directly, not `startHostedEngine` — so it does NOT run
    through the new renewal check. In practice this only matters for a
    tenant that (a) has been running continuously past the point its token
    is within 24h of expiry, AND (b) crashes and auto-restarts during that
    window, AND (c) no `/paper_start` has been called in the meantime to
    renew it first. That spawn would use the still-on-disk (soon-to-expire
    or already-expired) token. This is narrower than the original P0 (it
    requires a crash landing in a specific ~24h-to-7-day window, not "every
    tenant past day 7"), and self-heals the next time the user calls
    `/paper_start` (or the operator manually respawns), but is a real,
    disclosed gap rather than a silently-assumed-covered case. Flagged
    here for whoever picks up the next follow-up: the cleanest fix is
    likely having `FleetManager.launch()` itself call
    `renewHostedPairingStateIfNeeded` before an `isRestart` launch, which
    was NOT done in this branch to keep this fix narrowly scoped to the
    task's literal instruction (renew in `startHostedEngine`/
    `handlePaperStart`) and avoid entangling `fleet-manager.ts` (already
    twice-reviewed, DONE) with a new dependency on `hosted-pairing-seed.ts`
    without its own review cycle.
  - **Tests — real crypto, not shape checks**: `hosted-pairing-seed.test.ts`
    gained a hand-signing test helper (`signTestEntitlementToken`) that
    produces a REAL Ed25519-signed ARIAE1 token against the test's own
    synthetic entitlement key but with caller-controlled `iat`/`exp` (the
    real `issueReal1BetaEntitlementToken` always uses `iat = now`, so a
    genuinely near-expiry token has to be hand-signed to test against, not
    reimplemented-insecurely). New checks cover: (a) a token expiring in
    ~1h is renewed, the new token is verified by the REAL
    `aria-engine` `verifyEntitlement`/`checkPaperStartEntitlement`
    (imported from the sibling checkout, same pattern as the P0 fix's own
    tests), with a negative control proving the OLD near-expiry token
    really would have failed the gate 2h later; (b) a freshly-seeded
    healthy token is NOT re-signed — asserted both by field equality and a
    byte-for-byte file-content comparison before/after; (c) a missing/
    corrupt pairing-state.json self-heals via a fresh seed rather than
    throwing; (d) two back-to-back renewal calls (the closest reproducible
    approximation of a race between near-simultaneous `/paper_start` taps,
    given Node's single-threaded execution — disclosed as a real scope
    limit, not silently assumed to cover a genuine multi-process race) —
    the SECOND call correctly recognizes the first one's fix and does not
    re-renew, and the final on-disk file is always exactly one
    fully-valid, independently-re-verified token, never a mix. File-mode
    checks (0o600/0o700 preserved through a renewal) run when
    `process.platform !== "win32"` (POSIX mode bits aren't meaningfully
    enforced on this dev machine's OS). `hosted-commands.test.ts` gained a
    parallel wiring-level block (own env/dynamic-import setup, mirroring
    hosted-pairing-seed.test.ts, since a static import of
    `hosted-pairing-seed.js` would pull in `config.js` before this file's
    env vars could be set) proving `startHostedEngine` itself calls the
    real renewal function before `spawnTenant()`, that an already-hosted
    client's near-expiry token is genuinely replaced before the spawn
    call, that a second immediate `/paper_start` does not re-sign an
    already-healthy token, and that the brand-new-client create path is
    unaffected.
  - **Real end-to-end CLI proof — attempted, partial, honestly bounded**:
    seeded three real tenant runtime dirs (an already-expired token, a
    near-expiry-but-not-yet-expired token, and the same near-expiry token
    after running it through the real `renewHostedPairingStateIfNeeded`)
    using a synthetic entitlement keypair (same reason as the P0 fix's own
    proof — the real production `ARIA_ENTITLEMENT_PRIVATE_D` exists only in
    Railway), then ran the REAL `aria-engine` CLI (`node --import tsx
    src/cli.ts paper start` from `C:\Users\AIWMC\dev\aria-engine`,
    `ARIA_RUNTIME_DIR` pointed at each). A control against a completely
    unseeded dir reproduced the baseline "Device is not paired." All THREE
    seeded dirs — expired, near-expiry, and renewed alike — produced the
    IDENTICAL message: "Entitlement signature-invalid — run `aria pair
    <CODE>` to obtain a fresh entitlement." Reading `entitlement.ts`
    explains why: `verifyEntitlement` checks the Ed25519 signature BEFORE
    checking `exp` (`entitlement.ts:92-112`), so with a non-production
    signing key every token fails at the signature step regardless of
    expiry — the wrong-key failure masks any expired-vs-not distinction the
    real CLI could otherwise show. This means the real-CLI proof for THIS
    fix can only reconfirm gate #1 (pairing state) clears, exactly like the
    P0 fix's own proof — it CANNOT independently demonstrate the renewed
    token's improved expiry via the unmodified real binary in this
    environment. The genuine expiry proof is the unit-level one above,
    using the REAL `verifyEntitlement`/`checkPaperStartEntitlement`
    functions with their pre-existing, reviewer-confirmed `publicKeyX`
    test-injection parameter (not a shape check, not a reimplementation) —
    disclosed here as the honest ceiling on what a real-CLI run can prove
    without the production key, rather than claiming a stronger real-CLI
    proof than what was actually observed.
  - **Test/typecheck/regression results**: `npm run typecheck` — clean,
    zero errors. Full `npm test` (all 9 scripts, unchanged script list) —
    exit 0, zero `❌` lines (`grep -c "❌"` on the full captured output
    returns `0`). `hosted-pairing-seed.test.ts` standalone: all
    pre-existing checks plus 27 new renewal-specific checks, all passing.
    `hosted-commands.test.ts` standalone: all pre-existing checks plus 9
    new wiring-specific checks, all passing. No regressions in
    `fleet-manager.test.ts`, `fleet-manager.integration.test.ts`, or
    `dual-mode-coexistence.test.ts`.
  - **Status**: `IMPLEMENTED (awaiting review)` — an independent review of
    this fix has not yet happened.
  - **Commit**: `e2a4a8f`, pushed to `origin/fix/hosted-entitlement-renewal`.

- 2026-09-19 — **RE-CERTIFICATION after independent-review FAIL on `e2a4a8f`
  (status stays `IMPLEMENTED (awaiting review)` — a fresh independent review
  of THIS fix still needs to happen).** An independent reviewer failed the
  renewal fix above on one P0 and one lower-priority (P2) finding.
  - **D1 — P0, the blocker, FIXED.** `renewHostedPairingStateIfNeeded`
    (`src/fleet/hosted-pairing-seed.ts`) read the existing on-disk
    `pairing-state.json` (which is actually aria-engine's own `PairingState`
    shape — see `aria-engine/src/pairing-state.ts:38` — including
    `lastKnownEntitlementStatus`, written by the RUNNING engine on every
    real sync and consulted by `checkPaperStartEntitlement`,
    `entitlement-gate.ts:52-55`, to deny with `revoked-by-server` even for
    an offline-valid, correctly-signed token), but then constructed a BRAND
    NEW object with only `{clientId, lastSequence, entitlementToken}` and
    overwrote the whole file — silently erasing `lastKnownEntitlementStatus`
    and any other field the engine had written. **Concrete exploit
    reproduced by the reviewer**: admin `/revokeengine <id>` -> tenant's
    next real sync correctly caches `revoked` -> `/paper_start` correctly
    denied -> the token later enters its 24h renewal window -> the next
    `/paper_start` calls renewal, mints a fresh valid token, and silently
    WIPES the revoked cache in the same write -> the gate now grants
    access -> the revoked user is back in and can renew indefinitely.
    **Root cause confirmed exactly as flagged, not assumed**:
    `readHostedPairingStateFromDisk` does a bare `JSON.parse(...)` (no
    narrowing of unknown fields at runtime — TypeScript's `HostedPairingState`
    return-type annotation does not strip actual JS object properties), so
    the read step was never the problem; the loss happened purely at the
    WRITE step's object reconstruction. **Fix**: `renewHostedPairingStateIfNeeded`
    now re-reads the file immediately before writing (`preserveFrom`, see
    D2 below) and spreads `...preserveFrom` into the new state object
    FIRST, overriding only `clientId`/`lastSequence` (falling back to the
    function's arguments only when there is no existing file at all,
    exactly as before) and `entitlementToken` (when issuance succeeds) —
    never reconstructing a narrow object from scratch. `HostedPairingState`
    also gained an explicit (unused-by-this-module) `lastKnownEntitlementStatus?:
    unknown` field with a docblock explaining it exists only so the type
    documents what the spread preserves, not because this module ever sets it.
  - **New exploit-reproduction test** (`src/fleet/hosted-pairing-seed.test.ts`,
    `[exploit] ...` block): matches the reviewer's own reproduction exactly —
    (1) writes a pairing-state file with `lastKnownEntitlementStatus:
    {status: "revoked", ...}` plus a token expiring in ~1h (inside the 24h
    renewal margin), with a precondition check confirming the REAL
    `checkPaperStartEntitlement()` genuinely denies with `revoked-by-server`
    before renewal touches anything; (2) calls the real
    `renewHostedPairingStateIfNeeded`, confirming it actually renews (mints
    a genuinely new token, preserves `lastSequence`); (3) reads the file
    back and asserts `lastKnownEntitlementStatus` is still present and
    still exactly `"revoked"` (both on disk and on the function's own
    returned `state`); (4) drives the REAL aria-engine `verifyEntitlement()`
    (confirming the renewed token is, on its own, genuinely offline-valid —
    ruling out "the gate just failed for an unrelated reason") and the REAL
    `checkPaperStartEntitlement()` against the renewed on-disk state,
    asserting it STILL denies with `revoked-by-server` despite the freshly-
    signed, otherwise-valid token. All real Ed25519/real verifier, same
    established convention as this file's other tests — 9 new checks, all
    passing.
  - **D2 — P2, FIXED (the straightforward part) + disclosed (the rest).**
    The renewal read-modify-write wasn't coordinated with the live engine's
    own concurrent writes to the same file (it writes `lastSequence` on
    every sync tick), so renewal could rewind `lastSequence` to a stale
    value, causing the engine's next sync to be rejected as a replay
    (self-healing via `resyncSequence`, but reproducing a sync-desync
    signature this program has hit before). **Fix applied (simple, as
    instructed)**: `renewHostedPairingStateIfNeeded` now takes a SECOND
    read of the file (`preserveFrom`) immediately before the write, instead
    of building the written state from the read taken at the top of the
    function (`existing`, used only for the renewal-need decision) — this
    narrows the window during which a concurrent engine write would be
    clobbered, without requiring file-locking. **Not fully closed, disclosed
    in the docblock rather than silently ignored**: the engine could still
    write between this second read and this function's own `writeFileSync`
    — closing that completely needs real file-locking or atomic
    read-then-write coordination with the live engine process, which is out
    of scope for this fix cycle. New test (`[D2] ...`) proves the narrowed
    window actually works: a write simulating a concurrent engine sync
    tick landing between renewal's two internal reads is picked up (the
    newer `lastSequence` survives), not clobbered by the earlier, now-stale
    read.
  - **Docblock overclaim fixed**: `renewHostedPairingStateIfNeeded`'s
    docblock used to claim "there is no way for the file to end up torn or
    holding a mix of old/new fields." Softened to state precisely what is
    and isn't guaranteed: true for two sequential in-process calls and for
    `writeFileSync` completing normally; NOT a guarantee against a crash
    mid-`writeFileSync` — and aria-engine's own `loadPairingState()` does a
    bare `JSON.parse` with no try/catch, so a genuinely torn file would
    THROW there, not self-heal (this repo's own
    `readHostedPairingStateFromDisk` is more defensive, but that only
    protects renewal's own read, not whatever the spawned engine process
    reads next).
  - **Test/typecheck/regression results**: `npm run typecheck` — clean,
    zero errors. `npx tsx src/fleet/hosted-pairing-seed.test.ts` standalone —
    all pre-existing checks plus 11 new checks (9 exploit-reproduction + 1
    D2 spot-check, plus the pre-existing count), all passing, 0 failures.
    Full `npm test` (all 9 scripts, unchanged script list) — exit 0,
    `grep -c "❌"` on the full captured output returns `0`, `grep -c "^✅"`
    returns `404` total across the whole suite — confirming zero
    regressions in `fleet-manager.test.ts`,
    `fleet-manager.integration.test.ts`, `hosted-commands.test.ts`,
    `dual-mode-coexistence.test.ts`, or any of the earlier `test/*.ts`
    suites.
  - **Status**: `IMPLEMENTED (awaiting review)` — a fresh independent
    review of this fix still needs to happen.
  - **Commit**: `8f59d62`, pushed to `origin/fix/hosted-entitlement-renewal`;
    branch not merged anywhere.
