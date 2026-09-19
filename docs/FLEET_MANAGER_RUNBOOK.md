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

## 9. Task 6 soak test — final certification evidence (2026-09-19, RE-CERTIFIED)

**Script**: `scripts/fleet-soak.ts` (+ `scripts/fleet-soak-crashloop-fixture.mjs`,
`scripts/fleet-soak-marker-fixture.mjs`, `scripts/fleet-soak-crashloop-marker-fixture.mjs`).
Run: `npx tsx scripts/fleet-soak.ts`. Not part of `npm test` / CI — a manual
operational tool, per the plan's own "not necessarily a permanent CI test"
instruction. Uses the REAL `FleetManager` class against the existing FAKE
fixture (`src/fleet/test-fixtures/fake-engine.mjs`) — synthetic market mode,
zero real RPC calls, exactly as Task 6 specifies. This soaks **Fleet Manager
behavior** (spawn/monitor/stop/backoff/isolation under real concurrent OS
processes), NOT real `aria-engine` RPC/discovery robustness — that is a
separate, still-outstanding soak owned by the reference-driven-commercialization
program's own Task 10, and this run does not substitute for it.

### Re-certification note (read this first)

An independent reviewer **FAILED** the first Task 6 soak (commits `54ca099`,
`d66848a`) on three findings, none of which were a `FleetManager` defect —
all three were defects in this soak SCRIPT's own evidence-gathering logic,
which made its "GREEN" verdict unearned even though the underlying
`FleetManager` behavior it was trying to observe was, in fact, fine:

- **P0-1 — the log cross-contamination check was structurally vacuous.**
  It flagged contamination only if a tenant's log contained another
  tenant's `clientId` string — but nothing ever wrote a `clientId` into a
  log, so it could never fire (all 20 logs were byte-identical fixture
  boilerplate). **Fix**: each tenant now gets a genuinely distinctive,
  per-tenant marker (`SOAK-MARKER::<clientId>::END`) baked into `argv` via
  a dedicated `FleetManager` instance per tenant (see
  `markerInvocation()`/`crashLoopMarkerInvocation()` in the script and the
  new fixture files' docblocks) — this survives every restart FleetManager
  performs for that tenant, not just its first run. The contamination
  check now verifies a tenant's log contains ONLY its own marker, and a
  new ready-marker-COUNT check verifies each tenant's lifecycle matches
  its expected number of starts (control=1, SIGKILL-recovered=2,
  crash-loop-to-terminal=5).
- **P0-2 — the "control tenant unaffected" check was pure in-memory
  bookkeeping, no OS-level probe.** It only compared `getTenantStatus()`
  fields before/after fault injection, which would also pass if the
  isolation logic itself were silently broken but happened to report
  identical numbers. **Fix**: reused the script's existing `isPidAlive()`
  (already used for the shutdown-orphan check) to confirm each control
  tenant's ACTUAL OS process is still the SAME one from before injection,
  plus a real `fs.statSync()` size/mtime comparison on each control
  tenant's log file across the fault-injection window.
- **P1-3 — the tenant-count claim was overstated.** The prior runbook and
  script claimed "20 concurrent tenants sustained for 30 minutes," but the
  evidence JSON itself showed `activeTenantCount` was 20 only at t=0,
  dropping to 18 by t≈75-160s (the 2 crash-loop tenants correctly reaching
  terminal `failed` early, by design) and staying at 18 for the rest of
  the run. **Fix**: every claim below now says "20 tenants spawned; 18
  sustained concurrently" with the real timing, computed directly from
  `memSamples` rather than asserted.

**A fourth, real bug was found DURING this re-certification fix itself**
(disclosed here, not silently patched): the first version of the new
per-tenant marker, `SOAK-MARKER::<clientId>` with no closing delimiter, is
unbounded on the right — `SOAK-MARKER::soak-main-1` is a literal PREFIX of
`SOAK-MARKER::soak-main-10` through `...-19`. This was invisible in every
dry-run (which never reached two-digit tenant indices) but produced 10
false-positive "contamination" findings on the first full-scale (N=20)
re-run. **Fix**: closed the marker with a trailing `::END`
(`SOAK-MARKER::<clientId>::END`), which cannot be a substring of any other
tenant's differently-suffixed marker. Re-verified at N=20 scale (short
duration) that this produces zero false positives, then re-ran the full
30-minute soak — see the certified evidence below, from that final run.

**Both new checks were empirically proven able to fail, not just verified
to pass** (per this program's own "prove a check can fail, not just that
it didn't fire" discipline): a short dry-run with all tenant markers
deliberately collided produced 25 real cross-contamination findings; a
separate short dry-run that also SIGKILLed one "control" tenant (simulating
an isolation breach) produced `pidStillAliveSamePid: false` for that
tenant specifically, correctly flipping the aggregate isolation check to
`false`. Both temporary breaks were reverted before the certifying runs
below.

### Exact versions this soak ran against

- `aria-telegram-BOT-APP` (this repo, worktree
  `aria-telegram-BOT-APP-hosted-impl`, branch `work/hosted-paper-engine-impl`):
  commit `d66848a498cb7f0f7bf27d1d407469a359211fb3` (the soak itself ran
  against this SHA; the re-certification fix that produced the checks and
  numbers below landed in commit `1123008e72043df3927417ca6680700d56ed9c2d`).
- `aria-engine` (sibling checkout): branch `feat/hosted-runtime-dir-override`
  @ `69299df9a68d925281f181064cb84c83771698a3` (unchanged from the first
  soak — confirmed again via `git branch --show-current`/`git rev-parse
  HEAD` at this run's start, captured programmatically, not hand-typed).
- Both values are captured programmatically by the script itself and
  written into `scripts/fleet-soak-evidence.json` on every run.

### Run parameters (the certifying re-run that produced the evidence below)

- Phase 1 (warmup): N=5, held steady 90s — all 5 reached `running`, all 5
  stayed running and OS-alive throughout the hold, all 5 stopped cleanly,
  zero orphaned pids after stop.
- Phase 2 (main soak): **N=20 tenants SPAWNED** — 2 "crash-loop" tenants
  (configured to crash ~1.5s after every start, exercising the full
  backoff/give-up path), 3 "sigkill-target" tenants (killed directly via
  `process.kill(pid, "SIGKILL")`, bypassing `FleetManager.stopTenant()`
  entirely), 15 "control" tenants (never touched, used to prove
  isolation). Each of the 20 tenants runs under its OWN dedicated
  `FleetManager` instance (re-certification design change — see the note
  above for why: a per-tenant marker that must survive every restart
  requires a distinct `EngineInvocation` closure, which requires a
  distinct instance; `maxConcurrentTenants` set to 1 per instance, cost of
  20 in-memory instances vs. the prior 2 is negligible). `maxConcurrentTenants`
  itself (the concurrency-cap REJECTION logic) is unit-tested separately in
  `fleet-manager.test.ts` — Task 6 is a load soak of the OTHER protections,
  not a re-test of the cap's own rejection logic.
- Memory sampled 27 times across the run via `process.memoryUsage()` (this
  script's own process, hosting the real `FleetManager` instances) and, for
  every tenant, `tasklist` (Windows-native) parsed for each pid's real RSS.
- Total wall-clock elapsed for this soak run: **32 minutes 59 seconds**
  console summary (`totalElapsedMs: 1919280` in
  `scripts/fleet-soak-evidence.json` — the raw millisecond value is
  authoritative), run started `2026-09-19T14:22:43.583Z`, finished
  `2026-09-19T14:54:43.006Z`. The main-soak phase itself (Phase 2 only) ran
  for `totalElapsedMs: 1812266` (~30.2 minutes, against a 30-minute/
  1,800,000ms target — the extra ~12s is scheduling/sampling overhead, not
  a script defect).

### Tenant-count claim — corrected (P1-3)

**20 tenants were spawned; 18 were sustained concurrently for the rest of
the run.** From `memSamples` (real, not estimated): `activeTenantCount`
was 20 at t=0s, dropped to 18 by t≈74s (elapsedMs 73755), and stayed
EXACTLY 18 for every one of the remaining 26 samples through t≈1812s
(elapsedMs 1812266) — a sustained window of **1,738,511ms (≈29.0 minutes)**
at 18 concurrent tenants. The drop is CORRECT, DESIGNED behavior: the 2
crash-loop tenants are supposed to exhaust their 5-crash budget and reach
terminal `failed` quickly (confirmed: both did, at
`consecutiveCrashes===5`/`restartCount===4` — see "Restart/crash behavior"
below), not a defect and not something the prior "20 tenants for 30
minutes" phrasing should have implied.

### Resource behavior — real numbers

- **Fleet-Manager-hosting process RSS**: ranged **56,976 KB – 61,360 KB**
  across all 27 samples spanning the full ~30-minute main-soak window — no
  sustained upward trend (oscillates within a bounded band, consistent
  with ordinary V8 GC/allocator behavior for a process holding 20
  `TenantProcess` wrappers' event listeners and log-file streams across
  their lifetimes, not a leak).
- **Fleet-Manager-hosting process heapUsed**: ranged **8,166 KB – 8,946
  KB** across the same 27 samples — bounded, non-growing, including AFTER
  the fault-injection event at t≈516s.
- **Methodology, stated plainly**: "no leak" here means "RSS/heap did not
  grow beyond a small oscillating band over ~30 minutes of continuous
  concurrent operation including a fault-injection event," measured via 27
  real samples — it is NOT a formal long-run leak-detection methodology
  (e.g. an hours-long soak with heap snapshots diffed for retained-object
  growth) and should not be read as one.
- **Sample tenant OS-process RSS** (via `tasklist`, real per-pid values):
  ranged **47,924 KB – 55,152 KB** across all 20 tenants and all samples —
  a `tsx`-hosted Node process has a substantial fixed baseline RSS from the
  TypeScript/ESM loader itself; the fixture does no real work, so this
  baseline dominates and is expected, not a concern.
- **Conclusion**: no unbounded growth observed in either the Fleet Manager
  process or the sampled tenant processes across this real ~30-minute run.

### Tenant isolation — real evidence, now BOTH in-memory AND OS-level (P0-2 fix)

- **Control tenants (15 of 20, never touched)**:
  `controlTenantsCompletelyUnaffected = true`, composed of TWO
  independently-passing halves, both required:
  - **In-memory** (`controlTenantsCompletelyUnaffectedInMemory = true`):
    each control tenant's `pid`, `restartCount`, and `consecutiveCrashes`
    (== 0) were identical in the snapshot taken immediately before fault
    injection (t≈516s) and the final snapshot (t≈1812s/end of run), and
    `status` was still `"running"` in both.
  - **OS-level** (new — `controlTenantsOsLevelChecks`, all 15 entries
    pass): for every one of the 15 control tenants, `isPidAlive(prePid)`
    at end-of-run confirmed the SAME OS process (not a coincidentally
    identical-looking new one) is still alive, AND `fs.statSync()` on that
    tenant's log file showed IDENTICAL size and mtime at the instant fault
    injection began versus end-of-run — proof nothing was ever written to
    a control tenant's log during or after the fault-injection window.
  - None of the 3 SIGKILLs or the 2 crash-loop tenants' repeated crashes
    touched any control tenant's process, bookkeeping, or log file.
- **Per-tenant log-file isolation (P0-1 fix, now real)**: every one of the
  20 tenants' log files was scanned for (a) its OWN distinctive marker
  (must be present) and (b) every OTHER tenant's marker (must be absent).
  Result: `journalIntegrityIssues: []` — zero issues, on a check that is
  now capable of actually firing (proven by the deliberate-collision
  dry-run described above) rather than the prior version's structural
  no-op.
- **Ready-marker lifecycle count (new, P0-1)**: every tenant's log was
  also checked for the NUMBER of times the shared ready marker
  (`"paper engine started"`) appears, against its expected lifecycle.
  Result: **exact match for all 20 tenants** — control tenants: 1 each: 
  `soak-main-5`..`soak-main-19` all = 1; SIGKILL targets: 2 each
  (`soak-main-2`, `soak-main-3`, `soak-main-4` all = 2 — initial + the one
  post-SIGKILL auto-restart); crash-loop tenants: 5 each (`soak-main-0`,
  `soak-main-1` both = 5 — initial + 4 restarts before the 5th crash hits
  `maxConsecutiveCrashes=5` and gives up). Zero restart-path mismatches.
- **Per-tenant runtime-directory isolation**: unchanged from Task 2's
  design (`<tenantsRoot>/<clientId>/.aria`) — not re-tested here since
  Task 2's own isolation test already proves this at the OS level; this
  soak's contribution is proving it holds under real concurrent load for
  ~30 minutes.

### Restart/crash behavior — real evidence, both paths

- **SIGKILL'd tenants (3 of 20, killed directly via `process.kill(pid,
  "SIGKILL")` at t≈516s, bypassing `stopTenant()` entirely)**:
  `sigkilledTenantsAutoRecovered = true`. Concretely: `soak-main-2` (killed
  pid `12088`) → final pid `7972`; `soak-main-3` (killed pid `6516`) →
  final pid `27480`; `soak-main-4` (killed pid `50052`) → final pid
  `36840`. All three ended the run `status: "running"`,
  `consecutiveCrashes: 1`, `restartCount: 1`, `lastExitCode: 1` (the
  SIGKILL correctly treated as one ordinary crash, not conflated with the
  crash-loop tenants' repeated failures), and each log's ready-marker
  count matched the expected 2 exactly.
- **Crash-loop tenants (2 of 20, configured to crash ~1.5s after every
  start)**: `crashLoopTenantsEscalatedToFailed = true` — both
  (`soak-main-0`, `soak-main-1`) reached the documented terminal state
  exactly: final `status: "failed"`, `consecutiveCrashes: 5` (the
  configured `maxConsecutiveCrashes`), `restartCount: 4` (4 restarts
  attempted before the 5th crash triggered give-up), `lastExitCode: 1`,
  and each log's ready-marker count matched the expected 5 exactly — an
  independent, textual confirmation of the same lifecycle the in-memory
  fields report.
- **No spillover between the two fault types**: confirmed directly from
  the final snapshot — each group's numbers match only its own fault
  history, and the control group's isolation checks (above) independently
  confirm neither fault type touched them.

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
  pids; the 2 `failed` crash-loop tenants had no live process to begin
  with by end-of-run, correctly).

### Journal integrity

- "Journal" at the Fleet-Manager layer means each tenant's own log file
  (`<logsRoot>/<clientId>.log`) — the REAL `aria-engine` event journal is
  not exercised by this fake fixture at all, and this soak makes no claim
  about it (that is the reference-driven-commercialization Task 10 soak's
  job, on the real binary).
- All 20 tenants' log files were confirmed to exist, contain no null
  bytes, contain their OWN distinctive marker, contain NO other tenant's
  marker, and have a ready-marker count matching their expected lifecycle
  exactly — `journalIntegrityIssues: []`, zero issues found, on a check
  now proven capable of actually catching a real problem (see the
  re-certification note above for the two dry-run proofs and the one real
  bug this check itself found and had fixed along the way).

### Platform disclosure: Windows vs Linux (production) — stated plainly, not implied

This soak (both the original run and this re-certification) executed on
**Windows** — RSS sampling via `tasklist`, and the "external kill" fault
injection via `process.kill(pid, "SIGKILL")`, which on Windows maps to
`TerminateProcess()` (an immediate, non-catchable termination — there is no
POSIX signal-delivery semantics underneath it, Node's `SIGKILL` string is
just the closest available label). **Production targets Railway, which
runs Linux containers.** Real POSIX `SIGKILL` semantics (delivered by the
kernel, uncatchable, immediate) and Linux's process/cgroup teardown differ
in low-level detail from Windows' `TerminateProcess()`-based emulation,
even though the observable Node-level contract (`exit` event fires, pid
stops responding to `kill(pid, 0)`) is the same on both. **What this soak
certifies**: `FleetManager`'s OWN state-machine and isolation logic
(backoff, give-up, per-tenant isolation, clean-shutdown bookkeeping) —
this is pure JavaScript, platform-independent, and identical on Linux.
**What this soak does NOT certify**: Linux-specific process/signal
behavior itself (e.g. exact `SIGKILL` delivery timing under Linux cgroup
memory pressure, OOM-killer interaction, or Linux-specific zombie/orphan
reaping edge cases) — that would require running this same script on the
actual Railway/Linux target, which is out of scope for this task and is
flagged here as a real, disclosed gap rather than silently assumed
identical.

### Provider degradation — honest scope statement

This soak uses the FAKE fixture (`fake-engine.mjs`), which makes **zero
real RPC calls of any kind** — there is no real Solana RPC provider, no
real market-data feed, and no real discovery process anywhere in this
soak's scope, by design. Therefore: **"provider degradation" in the sense
of a real RPC endpoint going slow/unreachable is NOT meaningfully testable
at the Fleet-Manager layer with this fixture, and this soak does not claim
to have tested it.** The closest analogue this layer CAN exercise — a
tenant's underlying process misbehaving/dying, for any reason — is exactly
what the crash-loop and SIGKILL scenarios above already prove
`FleetManager` handles correctly. A genuine provider-degradation soak is
the reference-driven-commercialization program's own Task 10 to own.

### Final verdict: **GREEN**

| Category | Evidence | Verdict |
|---|---|---|
| Resource behavior | FleetManager-hosting process RSS 56,976–61,360 KB, heapUsed 8,166–8,946 KB across 27 samples over ~30 min, 20 tenants spawned/18 sustained, post-fault-injection — bounded oscillation, no growth trend | GREEN |
| Tenant isolation | 15/15 control tenants unaffected by BOTH in-memory bookkeeping AND OS-level pid-liveness + log-file-unchanged checks; zero cross-tenant log-marker contamination across 20 tenants (check proven capable of firing) | GREEN |
| Ready-marker lifecycle count | All 20 tenants' ready-marker counts exactly match their expected lifecycle (control=1, SIGKILL-recovered=2, crash-loop-to-terminal=5) — zero restart-path mismatches | GREEN |
| Restart/crash behavior | 3/3 SIGKILL'd tenants auto-recovered with new pids under real concurrent load; 2/2 crash-loop tenants correctly escalated to terminal `failed` at `consecutiveCrashes===5`/`restartCount===4`; zero spillover between fault groups | GREEN |
| Clean shutdown | Zero orphaned OS processes after full Fleet Manager shutdown, both warmup (N=5) and main soak (N=20 spawned), verified via real `process.kill(pid,0)` liveness probes | GREEN |
| Journal integrity | Zero corruption/cross-contamination across 20 tenants' log files, now via a check independently proven able to fail | GREEN |
| Tenant-count claim | Corrected: 20 spawned, 18 sustained concurrently for ≈29.0 of the ≈30.2-minute main-soak window, matching `memSamples` exactly | DISCLOSED, CORRECTED |
| Platform scope | Ran on Windows; production is Linux (Railway) — FleetManager's own state-machine/isolation logic is certified (platform-independent JS), Linux-specific process/signal behavior is NOT re-verified here | DISCLOSED, N/A for this layer |
| Provider degradation | NOT meaningfully testable at this layer with a synthetic, zero-RPC fixture — honestly scoped out, not claimed | N/A (disclosed, not a failure) |

**No real defect was found in `FleetManager` itself during this soak or its
re-certification.** Two real defects were found and fixed during this
task's OWN tooling, both disclosed above: (1) the original soak's
crash-loop timing bug (documented in the first soak's history, unchanged
by this re-certification), and (2) this re-certification's own marker
prefix-collision false-positive, found and fixed before the certifying
run. Per this program's own standing instruction not to downgrade a real
finding to look better, and equally not to inflate a self-found-and-fixed
test-harness bug into a false RED against `FleetManager` itself: the
verdict is GREEN because every `FleetManager` behavior this soak actually
exercised — resource bounds, isolation (now via genuinely capable checks),
crash/restart handling, clean shutdown, log integrity — held up correctly
under a real ~30-minute, 20-tenant-spawned/18-sustained, fault-injected
load.

### Raw evidence file

Full machine-readable evidence (every memory sample, every status
snapshot, every fault event, exact timestamps, the new
`controlTenantsOsLevelChecks`/`readyMarkerCounts`/`sustainedTenantCount`
fields) is at `scripts/fleet-soak-evidence.json`, regenerated by each run
of `scripts/fleet-soak.ts` (git-ignored-worthy scratch output, not
committed — the numbers in this section were transcribed from the
re-certifying run's own output and are the authoritative historical record
going forward, superseding the first soak's numbers wherever they
differ).
