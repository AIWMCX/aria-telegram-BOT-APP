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
| 1 | Confirm schema + runtime-path plumbing ready for multi-tenancy | IMPLEMENTED (awaiting review) | aria-engine `69299df` (branch `feat/hosted-runtime-dir-override`, NOT merged to aria-engine main); this repo `7e5d7a2` | | `ARIA_RUNTIME_DIR` env var added in aria-engine; `hosting_mode` column migration added here |
| 2 | Fleet Manager core (spawn/monitor/stop one tenant process) | NOT STARTED | | | Depends on: 1 |
| 3 | Resource bounds + crash-loop protection | NOT STARTED | | | Depends on: 2 |
| 4 | Wire Telegram commands to Fleet Manager | NOT STARTED | | | Depends on: 2, 3 |
| 5 | Dual-mode (local + hosted) coexistence test | NOT STARTED | | | Depends on: 4 |
| 6 | Soak the Fleet Manager itself | NOT STARTED | | | Depends on: 2, 3 |

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
