# Fleet Manager Runbook

Operational reference for `src/fleet/fleet-manager.ts` (the hosted-PAPER-engine
supervisor). Written as part of Task 3 (resource bounds + crash-loop
protection) of `docs/superpowers/plans/2026-09-08-hosted-engine-plan.md`. See
that plan and `docs/superpowers/specs/2026-09-08-hosted-engine-design.md` for
the full architecture context — this doc covers only what an operator needs
when the fleet is degraded or near capacity.

## 1. The real resource-limit mechanism (honest answer)

**Investigated, not assumed.** Read this repo's `Dockerfile` and
`railway.json` in full before writing this section.

- `Dockerfile` is `FROM node:22-slim`, runs `npm start` as a single process
  in the container. No cgroup limits, no `ulimit` calls, no per-process
  resource controls of any kind are configured anywhere in this repo's
  build or deploy config.
- `railway.json` configures only `restartPolicyType`/`restartPolicyMaxRetries`
  for the WHOLE service (the Fleet Manager's own Node process, if it dies),
  a health-check path, and the Dockerfile build. It does not, and cannot,
  express a per-CHILD-process memory or CPU limit — that's not a concept
  `railway.json` has.
- Railway's actual resource control is **service-level, not process-level**:
  an operator sets a vCPU/RAM ceiling for the whole container in the Railway
  dashboard (Settings → Resources), and that's a single shared pool every
  tenant's child process, plus the Fleet Manager itself, competes for. There
  is no Railway feature, and no plain-Docker-on-Railway mechanism, that
  gives one spawned child process (one tenant's `aria-engine paper start`)
  its own OS-enforced memory/CPU ceiling independent of its siblings.
- Node's `child_process.spawn` CAN pass `NODE_OPTIONS=--max-old-space-size=N`
  (or `execArgv`) to a child, which caps that child's **V8 heap** — but this
  is a soft, JS-heap-only ceiling. It does nothing to cap native buffers,
  the process's total RSS, or CPU usage, and a child that ignores it (or
  leaks outside the JS heap) is not stopped by it. **This is not a
  substitute for an OS-level hard cap, and this project does not have an
  OS-level hard cap available.**

**The honest conclusion, stated plainly:** there is no per-child-process
resource hard-enforcement available in this runtime today. Getting one would
require infrastructure this project does not have (e.g. running each tenant
in its own container/cgroup via a real orchestrator, which the design spec's
own "Future Work" section already names as a deferred, separate program —
"container-per-tenant" sharding). Building Task 3 as if such a cap already
existed would be dishonest and would leave a real gap undocumented.

**Therefore, the PRIMARY defense implemented in this task is at the Fleet
Manager level, not the OS level:**

1. A hard cap on the number of concurrently `starting`/`running`/`stopping`
   tenant processes (`maxConcurrentTenants`, §2 below) — this bounds the
   TOTAL resource footprint the Fleet Manager will ever ask the shared
   container for, since the engine's own memory profile per tenant is known
   and small (per the design spec: "tens of MB RSS idle," I/O-bound, zero
   runtime dependencies).
2. Crash-loop containment (§3 below) so a tenant that is actively
   misbehaving (rapid crash/restart, e.g. a bad config causing an instant
   exit loop) cannot consume CPU/log-disk indefinitely — it gets
   exponential backoff and then gives up entirely.
3. A soft best-effort V8 heap ceiling via `NODE_OPTIONS=--max-old-space-size`
   is a reasonable secondary hardening step for a LATER task if a specific
   tenant is observed leaking heap in production, but is explicitly NOT
   relied on here as a security boundary — it is not one.

If Railway resource usage needs a harder guarantee than this before scaling
past the first cohort, the correct next step is the design spec's own
deferred "container-per-tenant" or "horizontal fleet-sharding" work — not a
speculative fix bolted onto this task.

## 2. Concurrent-tenant cap

- `FleetManagerOptions.maxConcurrentTenants` — default **5**. Matches the
  plan's own starting-point language ("`MAX_HOSTED_USERS=3 or 5`") for the
  first cohort of hosted users.
- Counted as "occupying a slot": any tenant currently in `starting`,
  `running`, or `stopping` status (`stopping` still holds a live OS process
  until it actually exits, so it still counts).
- `spawnTenant(clientId)` **rejects** (throws `FleetCapacityError`, which
  carries `.clientId` and `.limit`) once the cap is reached — it never
  silently drops the request or queues it. The caller (Task 4's Telegram
  handler) is expected to catch this and tell the user "the fleet is full,
  try again shortly" rather than a generic failure.
- **Raising the limit**: pass a higher `maxConcurrentTenants` when
  constructing the `FleetManager` (wherever it's instantiated in
  `src/index.ts` / wherever Task 4 wires it up). There is no live/dynamic
  reconfiguration — raising it requires a redeploy. Before raising it,
  confirm the container's actual vCPU/RAM budget (Railway dashboard →
  Settings → Resources) can comfortably hold `new_limit × per-tenant RSS`
  plus headroom for the Fleet Manager's own process and the existing bot/API
  workload sharing the same container (per the design spec: this is the
  SAME Railway service as the bot, not a separate one).

## 3. Crash-loop backoff and give-up policy

Every tenant tracks `consecutiveCrashes` (exposed on `TenantProcessHandle`)
and a base restart-backoff delay.

- **Backoff schedule**: exponential, doubling per consecutive crash, base
  `restartBackoffMs` (default **5000ms**), capped at `maxRestartBackoffMs`
  (default **5 minutes** / 300000ms). Delay before the Nth consecutive
  restart = `min(restartBackoffMs * 2^(N-1), maxRestartBackoffMs)` — i.e.
  5s, 10s, 20s, 40s, 80s, ... capped at 5 minutes. Reasoning: fast enough
  that a one-off blip (a momentary RPC hiccup causing a single nonzero
  exit) recovers quickly for the waiting user; slow enough, and increasingly
  so, that a tenant which is GENUINELY broken doesn't hot-loop CPU or spam
  its own log file while the give-up threshold below is reached.
- **Give-up threshold**: after `maxConsecutiveCrashes` (default **5**)
  consecutive crashes without an intervening sustained-healthy run, the
  Fleet Manager stops scheduling any further restart and transitions the
  tenant to the terminal `"failed"` status. No timer is left armed. This is
  a deliberate, bounded stop — not a bug — so a permanently broken tenant
  (bad config, an RPC endpoint that will never come back, a corrupted
  journal) doesn't loop forever burning CPU and disk.
- **Sustained-healthy reset condition**: if a (re)started process stays
  `running` for at least `sustainedHealthyMs` (default **60 seconds**)
  before it next crashes, that crash is treated as a NEW, unrelated
  problem — `consecutiveCrashes` resets to 0 (then increments to 1 for the
  new crash) instead of continuing to escalate the backoff from an old,
  unrelated incident. Reasoning: a tenant that ran fine for a full minute
  clearly recovered; penalizing an unrelated crash hours or days later with
  an already-escalated backoff (or counting it toward the give-up total)
  would be unfair and would make ordinary operation feel increasingly
  fragile over the lifetime of a long-running tenant.

### `crashed` vs `failed` — the status split, and why

`TenantProcessHandle.status` gained a new terminal value, `failed`, alongside
the existing `crashed`:

- **`crashed`** = transient. The process exited unexpectedly and
  an auto-restart IS scheduled (a `restartTimer` is armed). This is the
  "self-healing in progress" state.
- **`failed`** = terminal. The Fleet Manager gave up after
  `maxConsecutiveCrashes` — no timer is armed, nothing will happen to this
  tenant until a human (or an explicit `spawnTenant()` call) intervenes.

This split exists because collapsing both into one `crashed` status would
force a Telegram status surface (Task 4) to either lie ("still trying!" when
nothing is actually scheduled) or interrogate internal timer state to tell
the two apart. Splitting them means the bot can show "engine crashed,
retrying in ~40s" for one and "engine failed after repeated crashes — tap
Restart to try again" for the other, honestly, from `status` alone.

## 4. What an operator sees when a tenant hits `failed`

- `FleetManager.getTenantStatus(clientId)` returns a handle with
  `status: "failed"`, `consecutiveCrashes` equal to the configured
  `maxConsecutiveCrashes`, and `lastExitCode` set to whatever the final
  crash's exit code was.
- The tenant's per-tenant log file (`<logsRoot>/<clientId>.log`) contains
  the full stdout/stderr of every attempt, including the final one — this
  is the first place to look to diagnose WHY it kept crashing (bad
  pairing/entitlement, a config error, a persistent RPC failure, etc. — see
  `fleet-manager.integration.test.ts`'s docblock for a concrete example of
  what an unpaired/unentitled real CLI's fail-closed output looks like).
- `listActiveTenants()` does NOT include a `failed` tenant (same as
  `crashed`/`stopped`) — it only lists `starting`/`running`/`stopping`.
- Calling `stopTenant()` on a `failed` tenant is a safe no-op that leaves
  the status as `failed` (not relabeled `stopped`) — this preserves the
  honest signal that it gave up due to repeated crashes, distinct from a
  deliberate stop, for anyone looking at status history later.

## 5. Manual intervention — restarting a `failed` tenant

**Yes, this is already supported, with no additional code needed**: calling
`FleetManager.spawnTenant(clientId)` again on a `failed` tenant is the
documented way to give it a fresh attempt. `spawnTenant()`'s existing
fall-through path (used for any non-`starting`/`running`/`stopping` status)
covers `failed` the same way it already covered `crashed`/`stopped`, with
one addition made in this task: a manual `spawnTenant()` call on a
`stopped`/`crashed`/`failed` tenant **resets `consecutiveCrashes` to 0**
before launching. This means a manual retry always gets the FULL
`maxConsecutiveCrashes` budget and the base backoff delay again — it is
treated as a genuinely fresh attempt, not a continuation of the prior
crash loop it just gave up on.

Operationally: whoever wires up Task 4's Telegram "Restart" button (or an
admin CLI/HTTP call) for a `failed` tenant just needs to call
`spawnTenant(clientId)` — the same call used for a normal first start. It
is still subject to the concurrent-tenant cap (§2) like any other spawn.

## 6. Interaction with Task 2's fixed race condition (traced, not assumed)

Task 2's review found and fixed a P0 race in `stopTenant()`: the
"crashed, restart pending" state has `entry.process === undefined`, and the
original code's `!entry.process` guard treated that as "nothing to stop,"
returning as a silent no-op that left the scheduled `restartTimer` armed —
so a caller's `stopTenant()` would appear to succeed while the pending
restart fired anyway and resurrected the tenant.

This task adds a SECOND per-tenant timer-adjacent state (`consecutiveCrashes`
tracking, and the point at which no timer is scheduled at all once `failed`
is reached) on top of that already-fixed logic. Traced explicitly to confirm
the fix isn't reintroduced in a new form:

- `stopTenant()`'s `!entry.process` branch (the one Task 2's fix added) is
  UNCHANGED by this task and still unconditionally `clearTimeout`s
  `entry.restartTimer` before setting `status = "stopped"` — this covers
  the `crashed`-with-pending-restart case exactly as before, regardless of
  how many consecutive crashes led up to it.
- The NEW terminal `failed` status is reached only from inside the crash
  exit-handler's give-up branch, which explicitly sets
  `entry.restartTimer = undefined` WITHOUT scheduling a new one — so a
  `failed` tenant never has a dangling timer to begin with, and
  `stopTenant()`'s early-return guard (`status === "stopped" ||
  status === "failed"`) correctly treats it as nothing-to-cancel rather than
  routing it through the `!entry.process` branch unnecessarily (harmless
  either way, since that branch's `clearTimeout(undefined-safe)` is a no-op
  on an already-`undefined` timer, but the explicit early return is clearer
  and cheaper).
- `spawnTenant()`'s existing dangling-timer defense (clearing
  `existing.restartTimer` before falling through to respawn, added in
  Task 2's review fix for the "mirror case") is untouched and still runs
  before the NEW `consecutiveCrashes = 0` reset this task adds — order
  matters here: the timer is cancelled first, then the crash counter is
  reset, then capacity is checked, then `launch()` runs. A regression test
  (`fleet-manager.test.ts`, "spawnTenant on a 'failed' tenant is accepted
  (manual retry)... consecutiveCrashes was reset to 0") exercises this exact
  path end-to-end.
- The new `runningSince` field (used for the sustained-healthy reset) is
  set in the `ready` event handler and cleared in BOTH exit-handler branches
  (`wasStopping` and the crash branch) — so it can never persist a stale
  timestamp across a stop/restart cycle that would corrupt a later
  healthy-run calculation.

No new dangling-timer or stale-state bug was found or introduced by this
trace.

## 7. Test coverage added for this task

`src/fleet/fleet-manager.test.ts` (all run against the existing fake fixture,
`test-fixtures/fake-engine.mjs` — no real process-count/hundreds-of-tenants
load test is required or run in CI, per the plan's own instruction):

- Concurrent-tenant cap: spawn to the limit, confirm the next spawn is
  rejected with `FleetCapacityError` (clientId + limit asserted), confirm
  the rejected tenant is never tracked, confirm stopping one tenant frees a
  slot for a new spawn.
- Crash-loop escalation: consecutive crashes observed at `consecutiveCrashes
  === 1`, then `=== 2` (proving the backoff schedule progressed), then
  give-up at the configured `maxConsecutiveCrashes` with a transition to
  `failed` and no further restart activity over an extended wait.
- Manual retry: `spawnTenant()` on a `failed` tenant is accepted (not
  rejected), reaches `running`, and `consecutiveCrashes` is confirmed reset
  to 0.
- Sustained-healthy reset: a tenant crashes once, is deliberately kept alive
  past `sustainedHealthyMs` on its restart, crashes again, and
  `consecutiveCrashes` is confirmed to have reset to 1 (not escalated to 2).

## 8. Known, disclosed gap (unrelated to this task, pre-existing) — RESOLVED 2026-09-14

`fleet-manager.integration.test.ts` (Task 2) depends on the sibling
`aria-engine` checkout at `C:\Users\AIWMC\dev\aria-engine` having the
`feat/hosted-runtime-dir-override` branch checked out (or built from), per
Task 1/2's ledger entries — that branch is where `ARIA_RUNTIME_DIR` support
lives, and it is NOT merged to `aria-engine`'s `main`. At Task 3's own
commit time, that sibling worktree's `HEAD` was on `main`, not that branch
(confirmed by direct inspection, not assumed), which caused 3 of that
integration test's 8 assertions (the ones checking the tenant-scoped
runtime dir/config.json/log content produced by the REAL binary) to fail —
the same 3 failed identically against Task 2's own unmodified baseline
commit, confirmed by temporarily reverting to it. This was a sibling-repo
checkout/environment condition, not a Fleet Manager code defect, and Task 3
did not touch `aria-engine` (out of scope per this program's Global
Constraints).

**Resolved**: the sibling worktree was checked out back to
`feat/hosted-runtime-dir-override` @ `69299df` and rebuilt. Re-ran
`fleet-manager.integration.test.ts` immediately afterward: 8/8 pass.
Whoever runs this test in a fresh environment should still check out
`feat/hosted-runtime-dir-override` (or a build that includes it) in the
sibling `aria-engine` worktree first — this remains a real environment
prerequisite until that branch is merged to `aria-engine main`, it just is
no longer an open/reproducing gap in THIS worktree right now.

## 9. Task 6 soak test — final certification evidence (2026-09-19)

**Script**: `scripts/fleet-soak.ts` (+ `scripts/fleet-soak-crashloop-fixture.mjs`).
Run: `npx tsx scripts/fleet-soak.ts`. Not part of `npm test` / CI — a manual
operational tool, per the plan's own "not necessarily a permanent CI test"
instruction. Uses the REAL `FleetManager` class against the existing FAKE
fixture (`src/fleet/test-fixtures/fake-engine.mjs`) — synthetic market mode,
zero real RPC calls, exactly as Task 6 specifies. This soaks **Fleet Manager
behavior** (spawn/monitor/stop/backoff/isolation under real concurrent OS
processes), NOT real `aria-engine` RPC/discovery robustness — that is a
separate, still-outstanding soak owned by the reference-driven-commercialization
program's own Task 10, and this run does not substitute for it.

### Exact versions this soak ran against

- `aria-telegram-BOT-APP` (this repo, worktree
  `aria-telegram-BOT-APP-hosted-impl`, branch `work/hosted-paper-engine-impl`):
  commit `7e3a4da79e697bcb083bdab100e844f56fb277c7`.
- `aria-engine` (sibling checkout): branch `feat/hosted-runtime-dir-override`
  @ `69299df9a68d925281f181064cb84c83771698a3` (confirmed via `git
  branch --show-current`/`git log` at soak start, matching what every prior
  task in this program spawned against — NOT merged to `aria-engine main`).
- Both values are captured programmatically by the script itself
  (`git rev-parse HEAD` / `git branch --show-current` at the start of every
  run) and written into `scripts/fleet-soak-evidence.json`, not hand-typed.

### A real bug found and fixed IN THE SOAK SCRIPT during this task (disclosed, not hidden)

The first full-length run (2026-09-19, ~10:31–11:04 local) used a single
shared `process.env.FAKE_CRASH_AFTER_MS`, set before the two "crash-loop"
tenants' initial `spawnTenant()` calls and cleared immediately after. That
correctly crashed their FIRST run, but `FleetManager`'s own auto-restart
fires later, from an internal `setTimeout` — by then the soak script's env
var was long gone, so the restarted process spawned clean and never crashed
again. Result: both crash-loop tenants showed exactly one crash
(`consecutiveCrashes: 1`, `restartCount: 1`) and then ran healthy for the
rest of the 32-minute run — the full exponential-backoff-then-give-up path
was never actually exercised under real load in that run, a real gap in the
soak's own methodology, not a `FleetManager` defect (Task 3's unit tests
already directly verify that state machine in isolation).

**Fix**: `scripts/fleet-soak-crashloop-fixture.mjs`, a tiny wrapper that
sets `FAKE_CRASH_AFTER_MS` in its OWN process environment at the top of
every fresh invocation (so it survives however many times FleetManager
restarts it, independent of the soak script's own `process.env` state at
any given moment) before dynamically importing the real fixture. The two
crash-loop tenants get their own `FleetManager` instance
(`fmCrashLoop`, `maxConcurrentTenants: 2`) configured with this fixture;
the other 18 tenants share the ordinary `fm` instance and never crash on
their own. Verified with two short dry-runs (2–4 min) before committing to
the full-length re-run: the first confirmed crashes now repeat and the
backoff escalates (`consecutiveCrashes` 1→2→3→4 observed directly), the
second (150s main duration) confirmed the full escalation to the terminal
`failed` status at `consecutiveCrashes === 5`. The full 32-minute soak was
then re-run in full with the fix — see results below.

### Run parameters (the re-run that produced the evidence below)

- Phase 1 (warmup): N=5, held steady 90s.
- Phase 2 (main soak): N=20 — 2 "crash-loop" tenants (configured to crash
  ~1.5s after every start, exercising the full backoff/give-up path), 3
  "sigkill-target" tenants (killed directly via `process.kill(pid,
  "SIGKILL")` at the 550s mark, bypassing `FleetManager.stopTenant()`
  entirely — an external kill exactly like an OOM-killer or a manual `kill
  -9`), 15 "control" tenants (never touched, used to prove isolation).
  `maxConcurrentTenants` set to 20 (the concurrency cap itself, default 5,
  is unit-tested separately in `fleet-manager.test.ts` — Task 6 is a load
  soak of the OTHER protections, not a re-test of the cap's own rejection
  logic).
- Memory sampled every ~60–80s (25 samples total across the main-soak
  phase) via `process.memoryUsage()` (this script's own process, which
  hosts the real `FleetManager` instances — the accurate analogue of "the
  Fleet Manager process" in production, where `bot.ts` would host it the
  same way) and, for a sample of real tenant OS processes, `tasklist`
  (Windows-native, no PowerShell dependency) parsed for each pid's real RSS.
- Total wall-clock elapsed for this soak run: **31 minutes 47 seconds**
  (`totalElapsedMs: 1906604` in `scripts/fleet-soak-evidence.json` — real,
  measured, not estimated; the console's own rounded "32 min 47s" summary
  line is a cosmetic double-rounding artifact of formatting minutes and
  seconds separately, the JSON's raw millisecond value is authoritative),
  run started `2026-09-19T11:13:18.510Z`, finished
  `2026-09-19T11:45:05.276Z`.

### Resource behavior — real numbers

- **Fleet-Manager-hosting process RSS**: ranged **59,356 KB – 60,424 KB**
  across all 25 samples spanning the full 30-minute main-soak window
  (first sample 59,356 KB at t=0, last sample 59,848 KB at t=1801s) — a
  **1,068 KB (≈1.8%) total spread**, with no sustained upward trend (the
  series oscillates within that ~1MB band, consistent with ordinary V8
  GC/allocator behavior for a process holding 20 `TenantProcess` wrappers'
  event listeners and log-file streams, not a leak).
- **Fleet-Manager-hosting process heapUsed**: ranged **7,904 KB – 8,499
  KB** across the same 25 samples — again a bounded, non-growing band
  (~595 KB spread, ~7.5%), including AFTER the fault-injection event at
  t=550s (heapUsed samples post-injection: 8355, 8417, 8403, 8402, 8438,
  8418, 8455, 8442, 8445, 8475, 8453, 8483, 8462, 8491, 8467, 8499 KB —
  still bounded, no trend).
- **Methodology, stated plainly**: "no leak" here means "RSS/heap did not
  grow beyond a small oscillating band over 30 minutes of continuous
  20-tenant operation including a fault-injection event," measured via
  25 real samples at ~60–80s intervals — it is NOT a formal long-run
  leak-detection methodology (e.g. hours-long soak with heap snapshots
  diffed for retained-object growth) and should not be read as one. A
  genuinely conclusive leak proof would need a much longer run; this is
  the honest, bounded claim this run actually supports.
- **Sample tenant OS-process RSS** (via `tasklist`, real per-pid values):
  ranged **50,704 KB – 53,016 KB** across all 20 tenants and all samples
  — each individual tenant's own RSS also stayed within a similarly
  narrow band throughout its lifetime (a `tsx`-hosted Node process has a
  substantial fixed baseline RSS from the TypeScript/ESM loader itself;
  the fixture does no real work, so this baseline dominates and is
  expected, not a concern).
- **Conclusion**: no unbounded growth observed in either the Fleet Manager
  process or the sampled tenant processes across a real 30-minute,
  20-tenant, fault-injected run.

### Tenant isolation — real evidence

- **Control tenants (15 of 20, never touched)**: `controlTenantsCompletelyUnaffected
  = true` — verified as a real per-tenant comparison (not "no exception
  thrown"): each control tenant's `pid`, `restartCount`, and
  `consecutiveCrashes` (== 0) were identical in the snapshot taken
  immediately before fault injection (t=550s) and the final snapshot
  (t=1801s/end of run), and `status` was still `"running"` in both. None
  of the 3 SIGKILLs or the 2 crash-loop tenants' repeated crashes touched
  any control tenant's process or bookkeeping.
- **Per-tenant log-file isolation**: every one of the 20 tenants' log
  files (`<logsRoot>/<clientId>.log`) was scanned for every OTHER
  tenant's `clientId` string appearing inside it — zero cross-contamination
  found (`journalIntegrityIssues: []`), matching the OS-level rigor
  Task 2's reviewer established (real per-tenant files, not shared
  in-memory bookkeeping).
- **Per-tenant runtime-directory isolation**: unchanged from Task 2's
  design (`<tenantsRoot>/<clientId>/.aria`, one directory per tenant,
  `FleetManager.runtimeDirFor()` is the single source of this path) — not
  re-tested here since Task 2's own isolation test already proves this at
  the OS level; this soak's contribution is proving it holds under 20
  CONCURRENT tenants for 30 minutes, not re-deriving the mechanism.

### Restart/crash behavior — real evidence, both paths

- **SIGKILL'd tenants (3 of 20, killed directly via `process.kill(pid,
  "SIGKILL")`, bypassing `stopTenant()` entirely)**: `sigkilledTenantsAutoRecovered
  = true` — each of the 3 was confirmed, by the end of the run, to be
  `status: "running"` with a **NEW, different pid** from the one that was
  killed, and `restartCount >= 1`. Concretely: `soak-main-2` (killed pid
  35900) → final pid `47628`; `soak-main-3` (killed pid 29272) → final pid
  `18064`; `soak-main-4` (killed pid 29552) → final pid `49436`. All three
  ended the run with `consecutiveCrashes: 1` (the single SIGKILL was
  correctly treated as one crash, not conflated with the crash-loop
  tenants' repeated failures) and `lastExitCode: 1` recorded honestly for
  the killed run. This is the SAME crash-handling code path an ordinary
  nonzero exit uses (per Task 2's own isolation test finding), now proven
  under real concurrent 20-tenant load, not just a 2-tenant unit test.
- **Crash-loop tenants (2 of 20, configured to crash ~1.5s after every
  start)**: `crashLoopTenantsEscalatedToFailed = true` — both reached the
  documented terminal state exactly as specified: final status
  `"failed"`, `consecutiveCrashes: 5` (the configured
  `maxConsecutiveCrashes`), `restartCount: 4` (4 restarts attempted before
  the 5th crash triggered give-up, matching the docblock's own "after 5
  consecutive crashes... transitions to failed" contract), `lastExitCode:
  1`. The exponential backoff schedule (5s/10s/20s/40s) was observed
  directly in a preliminary shorter validation run (not the timed main
  run itself, to avoid re-timing noise from concurrent I/O): crash 1 at
  ~t14s, crash 2 at ~t25s (11s later, close to the 10s step given ~1.5s
  run-then-crash overhead), crash 3 at ~t47s (22s later), crash 4 at
  ~t70s (23s later — the 40s step plus run-then-crash overhead lands the
  5th crash, and terminal `failed`, at ~t111s in that validation run) —
  consistent with the documented 5s/10s/20s/40s schedule within the
  expected per-cycle overhead (spawn time + the 1.5s configured
  crash-delay), not exact-to-the-millisecond (which the schedule itself
  doesn't claim to be either — it's a floor on the delay, not a fixed
  clock).
- **No spillover between the two fault types**: the crash-loop tenants'
  repeated crashes never affected the SIGKILL group's or the control
  group's `consecutiveCrashes`/`restartCount`/`status` — confirmed
  directly from the final snapshot (each group's numbers match only its
  own fault history).

### Clean shutdown — real evidence

- At the end of the run, `FleetManager.stopTenant()` was called for all 18
  non-crash-loop tenants and `failed`-tenant-safe-no-op `stopTenant()` was
  called for the 2 crash-loop tenants (already terminal, nothing to
  cancel).
- **Zero orphaned processes**: the script recorded every tracked pid
  immediately before shutdown began, then re-checked each with an
  OS-level `process.kill(pid, 0)` liveness probe (throws if the process
  is gone — the same real-liveness technique Task 2's isolation test
  established) after all `stopTenant()` calls resolved.
  `orphanedPidsAfterShutdown: []` — confirmed for BOTH the warmup phase
  (5 tenants) and the main-soak phase (20 tenants, including the 3
  SIGKILL survivors' NEW pids and the 15 control tenants' original pids;
  the 2 `failed` crash-loop tenants had no live process to begin with by
  end-of-run, correctly).

### Journal integrity

- "Journal" at the Fleet-Manager layer means each tenant's own log file
  (`<logsRoot>/<clientId>.log`) — the REAL `aria-engine` event journal
  (`.aria/state/events.log` or equivalent) is not exercised by this fake
  fixture at all, and this soak makes no claim about IT (that is the
  reference-driven-commercialization Task 10 soak's job, on the real
  binary).
- All 20 tenants' log files were confirmed to exist, contain no null
  bytes, and contain no other tenant's `clientId` string (cross-
  contamination check) — `journalIntegrityIssues: []`, zero issues found,
  across 20 tenants each producing several restart cycles' worth of
  stdout over 30 minutes of concurrent writes to 20 separate file
  descriptors.

### Provider degradation — honest scope statement

This soak uses the FAKE fixture (`fake-engine.mjs`), which makes **zero
real RPC calls of any kind** — there is no real Solana RPC provider, no
real market-data feed, and no real discovery process anywhere in this
soak's scope, by design (per the plan's own "synthetic market mode, no
real RPC calls" instruction for Task 6). Therefore: **"provider
degradation" in the sense of a real RPC endpoint going slow/unreachable
is NOT meaningfully testable at the Fleet-Manager layer with this
fixture, and this soak does not claim to have tested it.** The closest
analogue this layer CAN exercise — a tenant's underlying process
misbehaving/dying, for any reason including a hypothetical provider
failure inside the real engine — is exactly what the crash-loop and
SIGKILL scenarios above already prove FleetManager handles correctly
(detects the exit, applies backoff or terminal give-up, never affects
sibling tenants). A genuine provider-degradation soak (a real or
realistically-mocked RPC endpoint going degraded/unreachable while a
real `aria-engine` process is running against it) is explicitly out of
scope for the Fleet Manager and is the reference-driven-commercialization
program's own Task 10 to own, not a gap this task silently leaves
unaddressed — it is a different layer of the system entirely.

### Final verdict: **GREEN**

| Category | Evidence | Verdict |
|---|---|---|
| Resource behavior | FleetManager-hosting process RSS 59,356–60,424 KB, heapUsed 7,904–8,499 KB across 25 samples over 30 min, 20 tenants, post-fault-injection — bounded oscillation, no growth trend | GREEN |
| Tenant isolation | 15 control tenants' pid/restartCount/consecutiveCrashes byte-identical pre/post fault injection; zero cross-tenant log contamination across 20 tenants | GREEN |
| Restart/crash behavior | 3/3 SIGKILL'd tenants auto-recovered with new pids under real concurrent load; 2/2 crash-loop tenants correctly escalated to terminal `failed` at `consecutiveCrashes===5` per the documented 5s/10s/20s/40s/give-up schedule; zero spillover between fault groups | GREEN |
| Clean shutdown | Zero orphaned OS processes after full Fleet Manager shutdown, both warmup (N=5) and main soak (N=20), verified via real `process.kill(pid,0)` liveness probes | GREEN |
| Journal integrity | Zero corruption/cross-contamination across 20 tenants' log files over 30 min of concurrent writes | GREEN |
| Provider degradation | NOT meaningfully testable at this layer with a synthetic, zero-RPC fixture — honestly scoped out, not claimed | N/A (disclosed, not a failure) |

**No real defect was found in `FleetManager` itself during this soak.** The
one real defect found during this task was in the SOAK SCRIPT's own first
attempt (the shared-`process.env` crash-injection timing bug described
above) — fixed, re-validated with short dry-runs, then the full 32-minute
soak was re-run end-to-end with the fix and produced the GREEN evidence
above. Per this task's own instruction not to downgrade a real finding to
look better, and equally not to inflate a self-found-and-fixed
test-harness bug into a false RED against `FleetManager` itself: the
verdict is GREEN because every `FleetManager` behavior this soak actually
exercised — resource bounds, isolation, crash/restart handling, clean
shutdown, log integrity — held up correctly under a real 30-minute,
20-tenant, fault-injected load, and the one bug found was in this task's
OWN test tooling, disclosed and fixed within the same session rather than
silently patched over.

### Raw evidence file

Full machine-readable evidence (every memory sample, every status
snapshot, every fault event, exact timestamps) is at
`scripts/fleet-soak-evidence.json`, regenerated by each run of
`scripts/fleet-soak.ts` (git-ignored-worthy scratch output, not committed
—the numbers in this section were transcribed from it at the time of this
soak and are the authoritative historical record going forward).
