# ARIA Hosted PAPER Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task-by-task. Fresh implementer per task, independent reviewer after every task, fix/re-review before advancing — same discipline as `aria-engine`'s reference-driven-commercialization program (see that program's ledger for the standard this is held to: every task reviewed adversarially, several needed real fix cycles, nothing rubber-stamped).

**Goal:** let a paired user run their PAPER engine entirely on ARIA's
infrastructure, controlled through Telegram, with zero local process.

**Spec:** `docs/superpowers/specs/2026-09-08-hosted-engine-design.md` — READ IN FULL before Task 1. It documents the process-per-tenant architecture decision and why an in-process multi-tenant rewrite was rejected.

**Repos involved:**
- `aria-telegram-BOT-APP` (this repo) — the new Fleet Manager service, Telegram command wiring, schema changes.
- `aria-engine` (sibling repo, `C:\Users\AIWMC\dev\aria-engine`) — only touched if Task 1 finds the runtime-path override plumbing isn't fully wired end-to-end (function-level support exists per the spec's research; CLI/env-var wiring needs verification).

## Global Constraints

- PAPER remains the only executable mode this program ever spawns. The Fleet Manager spawns the SAME `aria-engine` CLI binary, unmodified — it must never gain a code path that could spawn anything else.
- No wallet private-key loading, seed phrases, signing, or broadcast anywhere in the Fleet Manager or its spawned processes. A hosted process's device keypair (Ed25519, `local-keystore.ts`'s existing contract) is not a wallet key and must never be treated as one.
- The `/api/engine/sync` protocol is NOT modified by this program. A hosted process and a local process must be indistinguishable to the sync endpoint.
- One tenant's process crash, resource exhaustion, or malformed config must never affect another tenant's process or the Fleet Manager itself — every task touching isolation must include a test that deliberately misbehaves and proves containment.
- Every task follows RED → GREEN → targeted tests → full suite → typecheck → security review → commit, matching this project's existing test conventions (check `aria-telegram-BOT-APP`'s existing test setup before assuming `aria-engine`'s hand-rolled `check()` pattern applies here — verify, don't assume).
- Existing local-CLI users must remain fully supported; this program is additive, never a forced migration.

---

### Task 1: Confirm schema and runtime-path plumbing are ready for multi-tenancy

**Files:**
- Read: `aria-engine/src/runtime/paths.ts`, `single-instance.ts`, `cli.ts` (confirm whether `RUNTIME_DIR`/lock-path overrides are wired through an env var or CLI flag today, or only reachable via direct function calls in tests).
- Create (if gap found): a migration in `aria-telegram-BOT-APP/migrations/` adding whatever `engine_clients` columns Task 1's own investigation determines are needed (e.g. `hosting_mode`, `hosted_process_status`) — do not invent columns speculatively; read the existing migrations listed in the spec first and decide based on real gaps.
- Modify (if gap found): `aria-engine/src/cli.ts` to accept a runtime-directory override via env var (e.g. `ARIA_RUNTIME_DIR`) if one doesn't already exist — this is the ONLY aria-engine change this whole program should need, per the spec's architecture decision.

- [ ] **Step 1: Verify the runtime-path override gap precisely**

Read `aria-engine/src/cli.ts`'s `cmdPaperStart()` and trace exactly which `paths.ts` constants it imports directly (`RUNTIME_DIR`, `CONFIG_PATH`, `LOCK_FILE_PATH`) vs. calls with a parameter. Confirm whether an env var already threads through, or whether the CLI hardcodes the home-directory path with no override mechanism reachable from outside a test file.

- [ ] **Step 2: If a gap exists, add ONE minimal override point**

An env var (e.g. `ARIA_RUNTIME_DIR`, checked once at CLI startup) that, if set, is used instead of `os.homedir()`-based defaults for every path in `paths.ts`. Do not add a CLI flag AND an env var — pick one, env var is more natural for a supervised child process. Add a test in `aria-engine/src/runtime/paths.test.ts` confirming the override works and that omitting it preserves the exact existing default behavior (zero regression for local-CLI users).

- [ ] **Step 3: Decide and apply schema changes**

Based on Step 1's findings and a read of every existing `engine_clients`-adjacent migration, decide whether new columns are genuinely needed to track hosting mode/process status, or whether `status`/`last_seen_at` already suffice with a new enum value. Write the migration only for a real, justified need.

- [ ] **Step 4: Run full test suites in both repos, typecheck, commit.**

**Acceptance:** The exact plumbing a per-tenant supervisor needs (a way to point one engine process at an isolated runtime directory) is confirmed present or added, with zero behavior change for existing local-CLI users, and schema is ready for Task 2.

---

### Task 2: Build the Fleet Manager core — spawn, monitor, stop one tenant process

**Files:**
- Create: `src/fleet/fleet-manager.ts`, `src/fleet/fleet-manager.test.ts`
- Create: `src/fleet/tenant-process.ts` (one spawned child's lifecycle wrapper), `.test.ts`

**Interfaces (design these against the real `child_process` API and the real `engine_clients` row shape confirmed in Task 1 — do not invent a shape divorced from either):**

```ts
export interface TenantProcessHandle {
  clientId: string;
  status: "starting" | "running" | "stopping" | "stopped" | "crashed";
  pid?: number;
  startedAt?: string;
  lastExitCode?: number | null;
  restartCount: number;
}

export class FleetManager {
  spawnTenant(clientId: string): Promise<TenantProcessHandle>;
  stopTenant(clientId: string, graceful: boolean): Promise<void>;
  getTenantStatus(clientId: string): TenantProcessHandle | undefined;
  listActiveTenants(): TenantProcessHandle[];
}
```

- [ ] **Step 1: Write failing tests using a FAKE spawned process** (a tiny test-only Node script that sleeps/echoes/exits with a controlled code — never spawn the real `aria-engine` CLI in unit tests; that belongs in an integration test later in this task).

Required cases: spawning creates a tracked handle in `starting` then `running`; stopping gracefully sends the right signal and transitions to `stopped`; a process that exits unexpectedly transitions to `crashed` and increments `restartCount` on auto-restart (decide and document a restart-backoff policy — do not restart-loop instantly on repeated crashes); `spawnTenant` for an already-running `clientId` is a no-op or explicit rejection (decide which, document why); `stopTenant` for a non-running `clientId` is a safe no-op.

- [ ] **Step 2: Implement using Node's `child_process.spawn`**, each child given `ARIA_RUNTIME_DIR` (from Task 1) pointed at a tenant-scoped directory, `env: { ...process.env, ARIA_RUNTIME_DIR: ... }`, stdout/stderr captured to a per-tenant log file (never mixed with another tenant's or the Fleet Manager's own stdout).

- [ ] **Step 3: Real integration test** — spawn the ACTUAL `aria-engine` CLI binary (built, from the sibling repo path) in `synthetic` market mode (never real-discovery in an automated test — no live RPC calls from CI), confirm it reaches `running`, produces its own tenant-scoped `.aria` directory, and stops cleanly.

- [ ] **Step 4: Isolation test (mandatory, per Global Constraints)** — spawn two tenants, deliberately crash/misbehave one (kill -9 it, or point it at an invalid config to make it exit nonzero repeatedly), assert the other tenant's process and the Fleet Manager itself are completely unaffected.

- [ ] **Step 5: Full suite, typecheck, commit.**

**Acceptance:** The Fleet Manager can spawn, monitor, and stop the real engine CLI as an isolated per-tenant child process, with crash containment proven by test, not asserted.

---

### Task 3: Resource bounds and crash-loop protection

**Files:**
- Modify: `src/fleet/fleet-manager.ts`, `.test.ts`
- Create: `docs/FLEET_MANAGER_RUNBOOK.md`

- [ ] **Step 1: Determine the real resource-limit mechanism available in this Railway/Docker runtime** (investigate — do not assume `--max-old-space-size` is sufficient or that cgroup limits are exposed; read the existing `Dockerfile` and Railway config for what's actually available, and document the real answer, including "none available, so we do X instead" if that's the honest finding).
- [ ] **Step 2: Enforce a max concurrent tenant-process count** as a Fleet Manager-level guard — reject new spawns past the limit with a clear, journaled reason, never silently drop a spawn request.
- [ ] **Step 3: Crash-loop backoff** — a tenant whose process crashes repeatedly in a short window gets exponential backoff on auto-restart, and past N failures, stops auto-restarting and surfaces a clear "needs manual intervention" status rather than looping forever.
- [ ] **Step 4: Tests for both limits** (mock the process count/crash-loop scenarios, don't require actually running hundreds of real processes in CI).
- [ ] **Step 5: Runbook** documenting the real limits, what an operator sees when they're hit, and how to raise them.
- [ ] **Step 6: Full suite, typecheck, commit.**

**Acceptance:** The Fleet Manager cannot be resource-exhausted by one misbehaving tenant, and an operator has a documented, evidence-based way to know when it's near capacity.

---

### Task 4: Wire Telegram commands to the Fleet Manager

**Files:**
- Modify: `src/bot.ts` (or wherever the bot's command handlers live — read the file first, this plan does not assume its exact current structure).
- Modify: `src/server.ts` if the Fleet Manager needs its own internal HTTP surface, or keep it in-process if `bot.ts` and the Fleet Manager can share the same Node process cleanly (decide based on the real current process boundary — read `src/index.ts`'s boot sequence first).

- [ ] **Step 1: Read the bot's current start/stop/pause command handling** — today it likely just sends the user instructions to run a local CLI command. Confirm this precisely before changing anything.
- [ ] **Step 2: Add a "hosted" path** — a Telegram command (or an inline button on the existing pairing flow) that calls `FleetManager.spawnTenant(clientId)` for that user's paired device, and reports success/failure back through the bot's existing DM pattern (`try { bot.api.sendMessage(...) } catch { logger.warn(...) }`, matching every existing notify function).
- [ ] **Step 3: Stop/pause command** wired to `FleetManager.stopTenant()`.
- [ ] **Step 4: Status command** shows real `TenantProcessHandle` state (running since when, restart count, last exit reason if crashed) — never a fabricated "all good" if the real state is degraded.
- [ ] **Step 5: Tests** for the new command handlers (mock the Fleet Manager, test the Telegram-facing logic in isolation, matching whatever test pattern this repo already uses for `bot.ts`).
- [ ] **Step 6: Full suite, typecheck, commit.**

**Acceptance:** A paired user can start/stop/check their PAPER engine entirely through Telegram, with zero local process, and honest status reporting.

---

### Task 5: Dual-mode coexistence test

**Files:**
- Create: an integration test proving a user can switch between local-CLI and hosted modes without state corruption or duplicate economic actions.

- [ ] **Step 1: Test scenario** — a user pairs, runs hosted mode, stops it, then runs the SAME `client_id` locally (or vice versa) — confirm the sync protocol's sequence-number/replay-rejection logic (already real, already tested in `aria-engine`) correctly prevents any double-processing, and that switching modes never produces two simultaneously-running processes for the same `client_id` (the Fleet Manager and a local CLI have no way to know about each other directly — this must be enforced via the EXISTING single-instance/sequence discipline, or a new explicit guard if that's insufficient; investigate and document which).
- [ ] **Step 2: If a gap is found, close it minimally** — do not build a new coordination mechanism if the existing sequence-number replay protection already makes double-processing impossible; only add something if a real gap is demonstrated by a failing test first.
- [ ] **Step 3: Full suite, typecheck, commit.**

**Acceptance:** A user can move between local and hosted execution without any risk of duplicate economic actions or corrupted state — proven by test, not assumed from the existing sync protocol's design intent.

---

### Task 6: Soak the Fleet Manager itself

**Files:**
- Create: a load-test script (not necessarily a permanent CI test — a runnable script under `scripts/` or similar) that spins up N synthetic tenants (synthetic market mode, no real RPC calls) and runs them concurrently for a bounded period.

- [ ] **Step 1: Run with a realistic N** (start small — 5, then 20 — document real memory/CPU observations from the actual Railway environment or a local equivalent, not a guess).
- [ ] **Step 2: Verify** no cross-tenant state leakage, no memory growth beyond what N tenants' own footprints predict, clean shutdown of all N on Fleet Manager stop, and that the resource-bound/crash-loop protections from Task 3 actually engage under real load (deliberately crash a few tenants during the soak).
- [ ] **Step 3: Record real evidence** (counts, durations, memory numbers) in `docs/FLEET_MANAGER_RUNBOOK.md` — no percentages without methodology, matching this program's own established discipline.
- [ ] **Step 4: Commit evidence-only documentation.**

**Acceptance:** Real operational evidence that the Fleet Manager holds up under a realistic multi-tenant load, with honest numbers, not feature-claim prose.

---

## Explicitly Deferred To Separate Plans

1. Horizontal fleet-sharding across multiple Railway services.
2. Per-tenant resource metering tied to billing/subscription tiers.
3. Any REAL2 execution work — this program never touches signing/broadcast/custody, on hosted infrastructure or anywhere else.
4. A dedicated "Radar"/dashboard UI for hosted-fleet operators (beyond the Telegram status command in Task 4).
