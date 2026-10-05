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

## 9. Task 6 soak test — evidence (2026-09-19, SECOND RE-CERTIFICATION CYCLE — awaiting a third independent review)

**Status caveat, stated first and plainly**: this section reports what the
run below actually measured. It has NOT yet been independently reviewed.
Treat every "PASS"/checkmark below as "this specific check, as coded, did
not fire on this specific run" — not as a general guarantee that
`FleetManager` has no isolation bugs. Two prior soak attempts on this exact
script were reviewed and found wanting (first: vacuous checks; second: a
topology that couldn't have caught the bug class it claimed to test) — the
correct prior applied here is skepticism of this section until a reviewer
who did not write it has independently re-run or re-derived it.

**Script**: `scripts/fleet-soak.ts` + `scripts/fleet-soak-fixture.mjs` (single
shared fixture, replacing the three separate fixture files from the first
re-certification cycle — see below). Run: `npx tsx scripts/fleet-soak.ts`.
Not part of `npm test` / CI — a manual operational tool, per the plan's own
"not necessarily a permanent CI test" instruction. Uses the REAL
`FleetManager` class against a FAKE process fixture — synthetic market mode,
zero real RPC calls, exactly as Task 6 specifies. This soaks **Fleet Manager
behavior** (spawn/monitor/stop/backoff/isolation under real concurrent OS
processes), NOT real `aria-engine` RPC/discovery robustness — that is a
separate, still-outstanding soak owned by the reference-driven-commercialization
program's own Task 10, and this run does not substitute for it.

### Why this is a SECOND fix cycle — what the first cycle got wrong

The first re-certification (commits `1123008`/`5f92185`, see the Log entry
below this section... actually see this file's history / the ledger for the
full narrative) fixed two real defects in the soak script's own checks (a
vacuous cross-contamination check, and an in-memory-only isolation check
with no OS-level probe) by giving every tenant a distinctive,
restart-stable log marker. To make that marker survive every
FleetManager-internal auto-restart, that fix used a *separate closure per
tenant* (`markerInvocation(clientId)`/`crashLoopMarkerInvocation(clientId)`),
and because `EngineInvocation` is configured once per `FleetManager`
instance (not per spawn call), that in turn required **20 separate
`FleetManager` instances** — one per tenant, each with
`maxConcurrentTenants: 1`.

A second independent review failed this fix. Its finding, confirmed correct
on inspection: `FleetManager` keeps ALL of its cross-tenant bookkeeping in a
**private, per-instance** `Map` (`src/fleet/fleet-manager.ts`'s internal
tenant-entry map). With 20 separate instances, a control tenant and a
crash-looping/SIGKILLed tenant shared **no state whatsoever** — they were,
from `FleetManager`'s own point of view, running inside 20 unrelated
supervisors that happened to share a process. A real bug where handling
tenant A's crash corrupts tenant B's bookkeeping (the exact bug class the
isolation check exists to catch) would have produced **zero signal** in
that topology, because there was no shared bookkeeping left to corrupt.
Only the OS-level probe (added in the same first fix) remained capable of
catching anything, and only for the narrow case of an externally-injected
OS-level kill — not an internal FleetManager logic bug.

The reviewer additionally proved the per-instance split was never
necessary. `FleetManager.launch()` already computes
`runtimeDirFor(clientId) = path.join(tenantsRoot, clientId, ".aria")`
(`src/fleet/fleet-manager.ts:196-198`), and `TenantProcess`'s constructor
(`src/fleet/tenant-process.ts:66-70`) sets this exact path as
`ARIA_RUNTIME_DIR` on **every** spawn it performs for that tenant — the
initial launch and every subsequent auto-restart, regardless of how many
`FleetManager` instances exist. A marker fixture can therefore read
`process.env.ARIA_RUNTIME_DIR` inside its own process and derive
`path.basename(path.dirname(ARIA_RUNTIME_DIR))` to recover its own
`clientId`, with zero need for a per-tenant `EngineInvocation` closure and
therefore zero need for a per-tenant `FleetManager` instance.

### The fix applied this cycle

1. **Restored ONE shared `FleetManager` instance for the entire main soak**
   (matching the original, first-reviewed topology from commit `54ca099`),
   with a real `maxConcurrentTenants` cap (set to `N`) actually engaged —
   removing the 20-separate-instances structure entirely.
2. **Replaced the three per-purpose fixture files**
   (`fleet-soak-marker-fixture.mjs`, `fleet-soak-crashloop-marker-fixture.mjs`,
   `fleet-soak-crashloop-fixture.mjs` — all deleted) **with one shared
   fixture**, `scripts/fleet-soak-fixture.mjs`, used by every main-soak
   tenant regardless of role. It derives its own marker from
   `ARIA_RUNTIME_DIR` (as above) and decides crash-loop behavior purely from
   its own clientId's naming convention (`soak-crashloop-*`, chosen by the
   soak script) — no argv parameter, no per-tenant closure. The `::END`
   marker-delimiter fix from the FIRST re-certification cycle is unchanged
   and still load-bearing (unbounded-prefix collision risk at two-digit
   tenant indices — see that fix's own history for the false-positive bug
   it closed).
3. **Corrected the three places that asserted a per-tenant `FleetManager`
   instance was REQUIRED** — this claim was factually wrong and has been
   removed/corrected in: `scripts/fleet-soak.ts`'s own comments (now
   documents WHY the shared instance is correct, not why a split one was
   needed), this runbook section (rewritten wholesale, this section), and
   the ledger (new entry logged for this fix cycle — see
   `docs/superpowers/plans/2026-09-08-hosted-engine-LEDGER.md`).
4. **Re-verified empirically, before the full run**, that both isolation
   channels are genuinely exercised again under the restored shared
   topology (ad hoc verification script, not committed — its output is
   transcribed here since it is evidence about the mechanism, not a
   reusable artifact):
   - Two tenants (`soak-control-0`, `soak-control-1`) spawned under ONE
     shared `FleetManager` instance. Each tenant's log contained only its
     own marker — no contamination, matching the expected clean case.
   - A marker COLLISION was then deliberately injected (appending
     `soak-control-1`'s marker string into `soak-control-0`'s log file) and
     confirmed the substring check that the real journal-integrity logic
     uses (`content.includes(otherMarker)`) correctly evaluates `true` on
     the contaminated file — i.e. the check is proven CAPABLE of firing,
     not merely never observed to fire. Reverted (this was against a
     temp-directory log file created for the test, not any committed
     artifact).
   - A control tenant was then SIGKILLed directly
     (`process.kill(pid, "SIGKILL")`, bypassing `FleetManager.stopTenant()`
     entirely) while sharing the SAME `FleetManager` instance as an
     untouched sibling control tenant. Confirmed BOTH channels caught it
     independently: **in-memory** — `getTenantStatus()` for the killed
     tenant transitioned from `running` to `crashed` (proving the shared
     bookkeeping `Map` actually observed and correctly classified the
     kill — this is the channel the second review found structurally
     unreachable under the 20-instance topology, and it is reachable
     again here); **OS-level** — `process.kill(originalPid, 0)` confirmed
     the original pid was genuinely gone. The killed tenant then
     auto-recovered via the normal backoff path (`status: running` again
     with a NEW pid after the backoff delay), and the untouched sibling
     control tenant's status/pid were completely unaffected throughout —
     confirming containment, not just detection.
5. **Ran the full soak** (N=5 warmup, N=20 main phase, real fault injection:
   3 tenants SIGKILLed directly, 2 tenants driven into crash-loop
   escalation, ALL under one shared `FleetManager` instance with
   `maxConcurrentTenants: 20` actually engaged) and regenerated
   `scripts/fleet-soak-evidence.json` from that real run — the previous
   evidence file (from the first re-certification cycle) had already been
   overwritten by the second reviewer's own break-testing runs, so this is
   fresh real data, not a reconstruction of the old numbers.

### Exact versions this soak ran against

- `aria-telegram-BOT-APP` (this repo, worktree
  `aria-telegram-BOT-APP-hosted-impl`, branch `work/hosted-paper-engine-impl`):
  commit `5f9218585b44e18e65a0c04336b6db0e739849f5` (the SHA captured
  programmatically by the script itself at the start of the run — the fix
  described above landed in a later commit on top of this one; see the
  ledger for the exact SHA).
- `aria-engine` (sibling checkout): branch `feat/hosted-runtime-dir-override`
  @ `69299df9a68d925281f181064cb84c83771698a3` — unchanged from both prior
  soak cycles, confirmed again programmatically at this run's start (not
  hand-typed).
- Both values are captured automatically by the script and written into
  `scripts/fleet-soak-evidence.json` on every run.

### Run parameters and real timing

- Phase 1 (warmup): N=5, held steady 90s. `allReachedRunning: true`,
  `allStillRunningAfterHold: true`, all 5 pids OS-alive throughout,
  `allStoppedCleanly: true`, `orphanedPidsAfterStop: []`.
- Phase 2 (main soak): **N=20 tenants spawned** under the ONE shared
  `FleetManager` instance (`maxConcurrentTenants: 20`) — 2 "crash-loop"
  tenants (`soak-crashloop-0`, `soak-crashloop-1`, configured to crash
  ~1.5s after every start), 3 "sigkill-target" tenants (`soak-sigkill-0/1/2`,
  killed directly via `process.kill(pid, "SIGKILL")` at t≈535s, bypassing
  `stopTenant()` entirely), 15 "control" tenants (`soak-control-0`..`-14`,
  never touched, used to prove isolation). `maxConcurrentTenants`'s own
  rejection logic is unit-tested separately in `fleet-manager.test.ts` —
  this soak is a load/isolation soak of the OTHER protections under the cap
  actually being engaged at N=20, not a re-test of the cap's rejection path.
- Memory sampled 25 times across the main-soak run via
  `process.memoryUsage()` (this script's own process, hosting the single
  real `FleetManager` instance) and, for every tenant, Windows `tasklist`
  parsed for each pid's real RSS (451 individual tenant-RSS data points
  across all samples and all 20 tenants).
- Real wall-clock timing (from `scripts/fleet-soak-evidence.json`, not
  estimated): run started `2026-09-19T18:41:10.422Z`, finished
  `2026-09-19T19:13:26.017Z`, total elapsed `totalElapsedMs: 1935445`
  (≈32 minutes 15 seconds). The main-soak phase alone ran
  `totalElapsedMs: 1819930` (≈30.3 minutes, against a 30-minute/1,800,000ms
  target — the ~20s excess is scheduling/sampling overhead, not a script
  defect). Fault injection fired at `elapsedMs: 535498` (≈8.9 minutes into
  phase 2, matching the configured `SOAK_FAULT_INJECT_AT_MS` default).

### Tenant-count claim — stated precisely, not rounded up

**20 tenants were spawned; 18 were sustained concurrently for the bulk of
the run.** From `memSamples` (real, not estimated): `activeTenantCount` was
20 at t=0s, dropped to 18 by t≈79s (the 2 crash-loop tenants correctly
exhausting their 5-crash budget and reaching terminal `failed` quickly, by
design — not a defect), and stayed exactly 18 for every one of the
remaining 23 samples through t≈1820s. Sustained window: **1,741,426ms
(≈29.0 minutes) at 18 concurrent tenants**, per
`phase2MainSoak.sustainedTenantCount`/`sustainedFromElapsedMs`/
`sustainedDurationMs` in the evidence file. This soak certifies "20
tenants spawned under one shared instance with a real concurrency cap
engaged, 18 sustained concurrently for ~29 minutes" — it does not certify
"20 concurrent for the full run," and this section does not claim that.

### Resource behavior — real numbers, this run

- **Fleet-Manager-hosting process RSS**: ranged **60,872 KB – 61,736 KB**
  across all 25 samples spanning the full main-soak window — a narrow,
  non-growing band (< 900 KB spread) consistent with ordinary allocator
  behavior for a process holding 20 `TenantProcess` wrappers' event
  listeners and log-file streams across their lifetimes, including through
  the fault-injection event. No sustained upward trend observed.
- **Fleet-Manager-hosting process heapUsed**: ranged **7,956 KB – 8,555 KB**
  across the same 25 samples — bounded, non-growing, including after fault
  injection.
- **Sampled tenant OS-process RSS** (via `tasklist`, real per-pid values,
  451 data points across 20 tenants and all samples): ranged **52,664 KB –
  55,480 KB** — a `tsx`-hosted Node process has a substantial fixed
  baseline RSS from the TypeScript/ESM loader itself; the fixture does no
  real work, so this baseline dominates and is expected, not a concern.
- **Methodology, stated plainly (unchanged caveat from prior cycles)**: "no
  growth observed" here means exactly that — bounded oscillation across a
  single ~30-minute run with 25 samples. It is NOT a formal long-run
  leak-detection methodology (hours-long soak, heap snapshots diffed for
  retained-object growth) and should not be read as one.

### Tenant isolation — both channels, now genuinely exercised under ONE shared instance

This is the section the second review specifically targeted, so it is
described precisely rather than with summary "GREEN" language a reader
could over-extend:

- **What this run demonstrates**: under a topology where all 20 tenants
  share ONE `FleetManager` instance's internal bookkeeping `Map` (the same
  structure a real cross-tenant bug would have to corrupt), the 15 control
  tenants' status, pid, restart count, and consecutive-crash count were
  bit-for-bit unchanged between the snapshot taken the instant fault
  injection began (t≈535s) and the final snapshot (t≈1820s) —
  `controlTenantsCompletelyUnaffectedInMemory: true` — AND, independently,
  each control tenant's ORIGINAL OS pid was confirmed still alive at
  end-of-run via `process.kill(pid, 0)` (not a coincidentally-identical NEW
  process), AND each control tenant's log file's size/mtime were byte- and
  timestamp-identical between the instant injection began and end-of-run —
  `controlTenantsOsLevelChecks`: all 15 entries pass
  (`pidStillAliveSamePid: true`, `logUnchangedSinceInjection: true` for
  every one). Combined: `controlTenantsCompletelyUnaffected: true`.
- **What this run does NOT demonstrate**: it does not prove `FleetManager`
  has no cross-tenant isolation bugs in general — it proves that on this
  one run, with this specific fault pattern (3 external SIGKILLs + 2
  internally-crash-looping tenants), the 15 control tenants' bookkeeping
  and processes were unaffected. A real isolation bug that only manifests
  under a different fault pattern, timing, or scale would not necessarily
  be caught by this specific run. The pre-run verification (item 4 above)
  establishes that the CHECK ITSELF is capable of firing when a fault is
  present — it does not and cannot establish that every possible fault is
  covered.
- **Per-tenant log-file isolation**: every one of the 20 tenants' log files
  was scanned for (a) its OWN distinctive marker (must be present) and (b)
  every OTHER tenant's marker (must be absent). Result:
  `journalIntegrityIssues: []` — zero issues found, on a check independently
  demonstrated capable of firing (see item 4 above).
- **Ready-marker lifecycle count**: every tenant's log was also checked for
  the number of times the shared ready marker (`"paper engine started"`)
  appears, against its expected lifecycle. Result: exact match for all 20
  tenants — `soak-control-0`..`-14`: 1 each; `soak-sigkill-0/1/2`: 2 each
  (initial + the one post-SIGKILL auto-restart); `soak-crashloop-0/1`: 5
  each (initial + 4 restarts before the 5th crash hits
  `maxConsecutiveCrashes=5` and gives up). Zero restart-path mismatches.

### Restart/crash behavior — real evidence, both paths

- **SIGKILL'd tenants (3 of 20, killed directly at t≈535s, bypassing
  `stopTenant()` entirely)**: `sigkilledTenantsAutoRecovered: true`.
  Concretely, from the final status snapshot: `soak-sigkill-0` (killed pid
  `48216`) → final pid `50236`; `soak-sigkill-1` (killed pid `15012`) →
  final pid `38856`; `soak-sigkill-2` (killed pid `53056`) → final pid
  `27600`. All three ended the run `status: "running"`,
  `consecutiveCrashes: 1`, `restartCount: 1`, `lastExitCode: 1` (the
  SIGKILL correctly treated as one ordinary crash, not conflated with the
  crash-loop tenants' repeated failures), and each log's ready-marker
  count matched the expected 2 exactly.
- **Crash-loop tenants (2 of 20, configured to crash ~1.5s after every
  start)**: `crashLoopTenantsEscalatedToFailed: true` — both
  (`soak-crashloop-0`, `soak-crashloop-1`) reached the documented terminal
  state exactly: final `status: "failed"`, `consecutiveCrashes: 5` (the
  configured `maxConsecutiveCrashes`), `restartCount: 4` (4 restarts
  attempted before the 5th crash triggered give-up), `lastExitCode: 1`,
  and each log's ready-marker count matched the expected 5 exactly.
- **No spillover between fault types, and no spillover into the control
  group**: confirmed directly from the final snapshot and the isolation
  checks above — each group's numbers match only its own fault history.

### Clean shutdown — real evidence

- At the end of the run, `stopTenant()` was called for all 18
  non-crash-loop tenants and for the 2 (already-terminal, safe-no-op)
  crash-loop tenants.
- **Zero orphaned processes**: every tracked pid was recorded immediately
  before shutdown began, then re-checked with an OS-level
  `process.kill(pid, 0)` liveness probe after all `stopTenant()` calls
  resolved. `orphanedPidsAfterShutdown: []` — confirmed for both the
  warmup phase (5 tenants) and the main-soak phase (20 tenants, including
  the 3 SIGKILL survivors' NEW pids and the 15 control tenants' original
  pids).

### Journal integrity

- "Journal" at the Fleet-Manager layer means each tenant's own log file
  (`<logsRoot>/<clientId>.log`) — the REAL `aria-engine` event journal is
  not exercised by this fake fixture at all, and this soak makes no claim
  about it (that is the reference-driven-commercialization Task 10 soak's
  job, on the real binary).
- All 20 tenants' log files were confirmed to exist, contain no null
  bytes, contain their OWN distinctive marker, contain NO other tenant's
  marker, and have a ready-marker count matching their expected lifecycle
  exactly — `journalIntegrityIssues: []`.

### Platform disclosure: Windows vs Linux (production) — unchanged from prior cycles

This soak (all three runs to date) executed on **Windows** — RSS sampling
via `tasklist`, and the "external kill" fault injection via
`process.kill(pid, "SIGKILL")`, which on Windows maps to
`TerminateProcess()` (an immediate, non-catchable termination — there is no
POSIX signal-delivery semantics underneath it, Node's `SIGKILL` string is
just the closest available label). **Production targets Railway, which
runs Linux containers.** What this soak certifies: `FleetManager`'s OWN
state-machine and isolation logic (backoff, give-up, per-tenant isolation,
clean-shutdown bookkeeping) — this is pure JavaScript, platform-independent,
and identical on Linux. What this soak does NOT certify: Linux-specific
process/signal behavior itself (exact `SIGKILL` delivery timing under
Linux cgroup memory pressure, OOM-killer interaction, Linux-specific
zombie/orphan reaping edge cases) — that would require running this same
script on the actual Railway/Linux target, out of scope here and flagged
as a real, disclosed gap.

### Provider degradation — honest scope statement (unchanged)

This soak uses a FAKE fixture that makes **zero real RPC calls of any
kind**. "Provider degradation" in the sense of a real RPC endpoint going
slow/unreachable is NOT meaningfully testable at the Fleet-Manager layer
with this fixture, and this soak does not claim to have tested it. The
closest analogue this layer CAN exercise — a tenant's underlying process
misbehaving/dying, for any reason — is what the crash-loop and SIGKILL
scenarios above already prove `FleetManager` handles correctly. A genuine
provider-degradation soak is the reference-driven-commercialization
program's own Task 10 to own.

### Summary table — described precisely, not as an unqualified verdict

Per the second review's specific finding that "GREEN" language in the
prior cycle's summary table invited an inference the evidence didn't
support, this table states what each row's evidence actually shows and
does not append a bare pass/fail verdict word:

| Category | What this run's evidence shows |
|---|---|
| Resource behavior | FleetManager-hosting process RSS 60,872–61,736 KB, heapUsed 7,956–8,555 KB across 25 samples over ~30 min main-soak window, including through fault injection — bounded, no growth trend observed on this single run |
| Tenant isolation (in-memory) | 15/15 control tenants' status/pid/restartCount/consecutiveCrashes bit-for-bit unchanged across the fault-injection window, under a topology where all 20 tenants share ONE FleetManager instance's bookkeeping Map — the channel a real cross-tenant bug would have to corrupt to go undetected |
| Tenant isolation (OS-level) | 15/15 control tenants' original OS pid confirmed still alive at end-of-run; 15/15 control tenants' log file size/mtime unchanged across the fault-injection window |
| Isolation-check capability, independently verified | Deliberate marker-collision injection produced a positive detection before this run; deliberate mid-run SIGKILL of a shared-instance control tenant was caught by both channels independently, with the untouched sibling unaffected — see item 4 above |
| Cross-tenant log-marker contamination | Zero found across all 20 tenants (`journalIntegrityIssues: []`), on a check independently proven capable of firing |
| Ready-marker lifecycle count | All 20 tenants' counts exactly match expected lifecycle (control=1×15, SIGKILL-recovered=2×3, crash-loop-to-terminal=5×2) |
| Restart/crash behavior | 3/3 SIGKILL'd tenants auto-recovered with new pids; 2/2 crash-loop tenants correctly escalated to terminal `failed` at `consecutiveCrashes===5`/`restartCount===4`; zero spillover between fault groups or into the control group |
| Clean shutdown | Zero orphaned OS processes after full shutdown, both warmup (N=5) and main soak (N=20 spawned) |
| Tenant-count claim | 20 spawned, 18 sustained concurrently for ≈29.0 of the ≈30.3-minute main-soak window, matching `memSamples` exactly |
| Platform scope | Ran on Windows; production is Linux (Railway) — FleetManager's own state-machine/isolation logic is platform-independent JS; Linux-specific process/signal behavior is NOT re-verified here |
| Provider degradation | Not meaningfully testable at this layer with a synthetic, zero-RPC fixture — scoped out, not claimed |

**No FleetManager defect was found on this run.** The defects found and
fixed across this program's three soak cycles to date were all in this
task's OWN tooling (the original soak's crash-loop timing bug; the first
re-certification's vacuous checks and its own marker-prefix collision bug;
this cycle's per-instance-topology defect) — none were in `FleetManager`
itself. This is stated as an observation about this specific tooling's
history, not as a general claim that `FleetManager` is defect-free; a third
independent review of this cycle's fix is still required before this task
can be marked reviewed-pass (see the ledger's Status column).

### Raw evidence file

Full machine-readable evidence (every memory sample, every status
snapshot, every fault event, exact timestamps, `controlTenantsOsLevelChecks`,
`readyMarkerCounts`, `sustainedTenantCount`) is at
`scripts/fleet-soak-evidence.json`, regenerated by each run of
`scripts/fleet-soak.ts` (scratch output, not meant to be hand-edited — the
numbers in this section were transcribed directly from this cycle's run and
supersede both prior cycles' numbers wherever they differ).
