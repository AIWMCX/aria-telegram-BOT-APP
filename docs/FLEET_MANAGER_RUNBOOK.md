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
