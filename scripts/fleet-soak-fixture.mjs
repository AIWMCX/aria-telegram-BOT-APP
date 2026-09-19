#!/usr/bin/env node
/**
 * Single, shared fixture used by scripts/fleet-soak.ts's main-soak phase for
 * EVERY tenant (crash-loop, SIGKILL-target, and control alike), run under
 * ONE shared `FleetManager` instance.
 *
 * SECOND FIX CYCLE (2026-09-19) — replaces the per-tenant-FleetManager-
 * instance design (fleet-soak-marker-fixture.mjs /
 * fleet-soak-crashloop-marker-fixture.mjs / fleet-soak-crashloop-fixture.mjs,
 * all now unused/removed) that a second independent review correctly found
 * both unnecessary and actively harmful: splitting the soak across 20
 * separate `FleetManager` instances (one per tenant, each with
 * `maxConcurrentTenants: 1`) meant no two tenants ever shared the private
 * per-instance bookkeeping `Map` that real cross-tenant isolation bugs would
 * corrupt — making the soak's in-memory isolation channel structurally
 * unable to detect the exact bug class it exists to catch. The reviewer also
 * proved the per-instance split was never required in the first place: every
 * `TenantProcess` this fixture's parent spawns already has `ARIA_RUNTIME_DIR`
 * set to `<tenantsRoot>/<clientId>/.aria` (see `FleetManager.runtimeDirFor()`
 * in `src/fleet/fleet-manager.ts` and `TenantProcess`'s constructor in
 * `src/fleet/tenant-process.ts`, which sets this env var on EVERY spawn,
 * including every auto-restart) — so a per-tenant, restart-stable,
 * collision-free marker was always derivable from that env var alone, with
 * zero need for a distinct `EngineInvocation` closure per tenant and
 * therefore zero need for a distinct `FleetManager` instance per tenant.
 *
 * This fixture:
 *   1. Reads `process.env.ARIA_RUNTIME_DIR` (set by TenantProcess on every
 *      launch, initial or restart) and derives this tenant's `clientId` as
 *      `path.basename(path.dirname(runtimeDir))` — the inverse of
 *      `runtimeDirFor(clientId) = path.join(tenantsRoot, clientId, ".aria")`.
 *   2. Derives the SAME per-tenant marker format the soak script's own
 *      `markerFor()` uses (`SOAK-MARKER::${clientId}::END` — the `::END`
 *      delimiter fix from the first re-certification cycle is unchanged and
 *      still load-bearing: without it, `soak-crashloop-1`'s marker would be
 *      a literal substring of `soak-crashloop-10`'s..`-19`'s, producing false
 *      cross-contamination positives at N>=11) and sets `FAKE_EXTRA_LINE` to
 *      it so `fake-engine.mjs` prints it right after its ready line.
 *   3. Decides crash-loop behavior PURELY from the clientId's naming
 *      convention (`soak-crashloop-*`, chosen by scripts/fleet-soak.ts) —
 *      NOT from argv, NOT from a distinct closure/instance — setting
 *      `FAKE_CRASH_AFTER_MS` only for those tenants, exactly mirroring the
 *      original (byte-for-byte verified, untouched-by-review)
 *      `fleet-soak-crashloop-fixture.mjs` mechanism this replaces.
 *   4. Re-execs `src/fleet/test-fixtures/fake-engine.mjs`, unmodified.
 *
 * Usage: fleet-soak-fixture.mjs <start|stop>  (no argv marker — everything
 * needed is derived from ARIA_RUNTIME_DIR, which is already set in this
 * process's own env before this file runs).
 * Env: SOAK_CRASHLOOP_MS (optional, default 1500ms) — same knob the old
 *      crash-loop fixture exposed.
 */
import path from "node:path";

const runtimeDir = process.env.ARIA_RUNTIME_DIR;
if (runtimeDir) {
  const clientId = path.basename(path.dirname(runtimeDir));
  process.env.FAKE_EXTRA_LINE = `SOAK-MARKER::${clientId}::END`;
  if (clientId.startsWith("soak-crashloop-")) {
    process.env.FAKE_CRASH_AFTER_MS = process.env.SOAK_CRASHLOOP_MS ?? "1500";
  }
}
await import("../src/fleet/test-fixtures/fake-engine.mjs");
