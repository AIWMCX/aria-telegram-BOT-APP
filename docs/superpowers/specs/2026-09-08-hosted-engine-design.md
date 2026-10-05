# ARIA Hosted PAPER Engine — Design Spec

## Problem

`aria-engine` is a real, working PAPER trading engine — Stages 1–4 and the
reference-driven-commercialization program's Tasks 1–9 are all shipped and
independently reviewed. But it only runs one way today: a user installs
Node, clones/builds the repo, and runs `node dist/cli.js paper start` in a
terminal they keep open. That is fundamentally incompatible with the UX
every competitor in this space (Trojan, Photon, BullX, Padre) offers:
open Telegram, tap a button, done. No terminal, no device, no uptime
burden on the user.

**Goal:** let a user pair once via Telegram (the pairing flow already
exists — `POST /api/engine/pair`) and then have their PAPER engine run
continuously on ARIA's own infrastructure, controlled entirely through
Telegram commands, with zero local process required.

## Non-Goals (explicit, carried over from the standing REAL2 boundary)

- No wallet private-key loading, seed phrases, transaction signing,
  transaction broadcast, or custody — on the hosted engine OR anywhere
  else. This is a **hosting/UX change**, not a REAL2 execution change.
  Everything the hosted engine runs is the exact same PAPER-only
  `aria-engine` codebase, unmodified in its execution semantics.
- No change to `src/paper/*`'s trading logic, safety evaluators, or
  PAPER accounting. This program touches process lifecycle and storage
  location, not trading behavior.
- No multi-region/high-availability guarantees in v1 — a single Railway
  service, vertically scaled, is the target for the first cohort of
  users. Horizontal fleet-sharding is an explicit future program, not
  in scope here.
- No migration compulsion — existing local-CLI users are not forced
  onto the hosted model; both remain supported (a user's `client_id`
  in `engine_clients` doesn't care whether the device polling it is a
  laptop or a hosted process).

## Architecture Decision: process-per-tenant, not in-process multi-tenancy

Two shapes were considered:

1. **Rewrite `PaperEngine`/`DiscoveryMarketSource`/etc. into a
   multi-tenant-safe in-process library** — one Node process holds N
   `PaperEngine` instances in memory, keyed by tenant. Rejected: this
   engine's modules currently import module-level constants
   (`RUNTIME_DIR`, the single-instance lock) as singletons by design —
   see `aria-engine/src/runtime/paths.ts` and `single-instance.ts`. Making
   every one of those genuinely tenant-safe touches a large fraction of
   the codebase that Tasks 1–9 already hardened and reviewed, for a
   payoff (lower per-tenant memory) this workload doesn't need — the
   engine is I/O-bound polling, not compute-bound (confirmed: zero
   runtime dependencies, tens of MB RSS idle, per direct inspection of
   `package.json` and `polling-transport.ts`'s bounded-concurrency pool).

2. **A lightweight supervisor spawns the EXISTING, unmodified CLI as one
   child process per tenant**, each pointed at a tenant-scoped runtime
   directory via already-supported override parameters
   (`ensureRuntimeDirs(root)`, `acquireLock(lockPath)` in
   `aria-engine/src/runtime/paths.ts`/`single-instance.ts` already take
   these as arguments — this is real, already-existing plumbing, not
   something to build from scratch). **Chosen.** This reuses 100% of the
   already-reviewed engine code unchanged, isolates one tenant's crash
   from every other tenant's process (a crash in user A's engine cannot
   corrupt user B's journal/state — they're separate OS processes with
   separate filesystems), and needs a genuinely small, self-contained
   new component: a supervisor.

Sizing (from direct inspection, not a guess): "tens to low hundreds of
concurrent lightweight Node processes on a few vCPUs / a few GB RAM" is
realistic for this workload shape on typical Railway compute. Past that,
this design's own "Future Work" section names the upgrade path
(container-per-tenant, or fleet-sharding across multiple Railway
services) — not built here, deliberately, since building for a user
count this program doesn't have yet would be premature.

## Component: the Fleet Manager

A new service, `aria-fleet-manager`, living in `aria-telegram-BOT-APP`
(same repo/deploy as the existing bot/control-plane — NOT a new Railway
project, to avoid inter-service network complexity for v1). Responsibilities:

- **Process lifecycle**: spawn, monitor, and cleanly stop one
  `aria-engine` CLI child process per active hosted tenant, using
  Node's `child_process.spawn` (not a job queue — this is a long-lived
  stateful loop per tenant, not a discrete task; a queue is the wrong
  primitive here, confirmed by the architecture research).
- **Per-tenant isolation**: each spawned process gets its own runtime
  directory (`/data/tenants/<client_id>/.aria`, mounted on the same
  Railway volume the bot app's SQLite already uses — see `Dockerfile`'s
  existing `/data` mount) and its own lock file — never a shared
  `~/.aria`. This is a real security/correctness boundary: one tenant's
  malformed config or corrupted journal must never affect another's.
- **Resource bounds**: a documented, enforced max concurrent process
  count and a per-process memory ceiling (Node's `--max-old-space-size`
  or an OS-level cgroup limit, whichever Railway's runtime actually
  supports — verified during implementation, not assumed here) — so
  one runaway tenant cannot starve the others.
- **Health surface**: expose process state (running/crashed/stopped,
  uptime, last-restart reason) per `client_id`, reusing the SAME
  `engine_clients.status`/`last_seen_at` columns the sync protocol
  already writes — no parallel state model.
- **Command intake**: the Telegram bot's existing `start`/`stop`/`pause`
  intent (today: instructions telling the user to run a local CLI
  command) instead calls the Fleet Manager's internal API to spawn/stop
  the tenant's process. This is additive to the bot's existing command
  surface, not a rewrite of it.

## What does NOT change

- The `/api/engine/sync` protocol (pairing, sequence-numbered
  event-batch push, Ed25519 device-signature verification) is UNCHANGED.
  A hosted engine process authenticates exactly the same way a local one
  does — with its own device keypair, generated the first time it's
  spawned and persisted to its tenant-scoped runtime directory. The
  control plane cannot tell, and does not need to tell, whether a given
  sync request came from a laptop or a hosted process. This is the
  single biggest reason this design is safe: it adds a new way to RUN
  the engine, without touching the trust boundary between engine and
  control plane at all.
- `engine_clients.id` continues to be the tenant key — no new identity
  system. A user who pairs today already has the exact row a hosted
  process needs to be spawned against.
- PAPER accounting, safety evaluators, exit logic, journal format —
  all untouched. The Fleet Manager never reads or writes `aria-engine`
  internals directly; it only starts/stops the CLI process and watches
  its exit code/stdout for health signals, the same way an operator
  running it locally would watch a terminal.

## Security considerations

- Each tenant's runtime directory must be inaccessible to every other
  tenant's process — filesystem permissions scoped per directory, not
  relying on the application layer alone.
- A hosted engine process's device keypair is generated server-side on
  first spawn and never leaves the Fleet Manager's storage — this is a
  DEVICE identity (Ed25519, matches `local-keystore.ts`'s existing
  contract), never a wallet key, and this program does not change that
  invariant.
- Resource exhaustion by one tenant (e.g. a runaway RPC retry loop) must
  degrade only that tenant's process, never the Fleet Manager itself or
  other tenants — enforced via the resource bounds above, tested under
  a deliberately misbehaving fixture before this ships.

## Open questions for the implementation plan to resolve, not guessed at here

- Exact Railway resource-limit mechanism available for per-child-process
  memory/CPU capping (needs verification against Railway's actual
  runtime, not assumed).
- Whether `engine_clients` needs new columns (e.g. `hosting_mode:
  "local"|"hosted"`, `hosted_process_status`) or whether existing
  columns suffice — a real schema-design decision for Task 1 of the
  implementation plan, backed by reading the migration files listed
  above, not invented here.
- Exact Telegram command surface changes (new buttons/commands vs.
  reusing existing `start`/`stop` intents) — a product decision for the
  implementation plan's UX task, not this spec.

## Future Work (explicitly deferred, not this program)

- Horizontal fleet-sharding across multiple Railway services once
  concurrent hosted-tenant count exceeds single-service capacity.
- Per-tenant resource metering for billing (ties into the existing
  entitlement/subscription model, but is a separate, later program).
- REAL2 execution on hosted infrastructure — explicitly and permanently
  out of scope for this design; any future REAL2 hosting work is a
  separate authorization and a separate program, per the standing
  REAL2 governance already on record in `aria-engine/docs/REAL2_EXECUTION_STATE.md`.
