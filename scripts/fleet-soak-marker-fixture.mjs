#!/usr/bin/env node
/**
 * Wrapper around src/fleet/test-fixtures/fake-engine.mjs that bakes a
 * per-tenant `FAKE_EXTRA_LINE` marker into the process's OWN environment,
 * used only by scripts/fleet-soak.ts so each soak tenant gets a genuinely
 * distinctive, greppable line in its own log file across EVERY invocation
 * FleetManager ever makes for it — the initial start AND every subsequent
 * auto-restart.
 *
 * Why this file exists instead of just setting `process.env.FAKE_EXTRA_LINE`
 * before `spawnTenant()` the way `fleet-manager.test.ts:330-337` does: that
 * approach only survives a tenant's FIRST run. A later FleetManager-internal
 * restart fires from an internal `setTimeout`, long after the soak script's
 * own loop has moved on to (and overwritten `process.env` for) other
 * tenants — the restarted child would inherit whichever marker happened to
 * be sitting in the soak script's `process.env` at that later moment, not
 * its own. This is the exact same class of bug documented in
 * fleet-soak-crashloop-fixture.mjs for `FAKE_CRASH_AFTER_MS` (found during
 * the first Task 6 soak attempt). Baking the marker into `argv` instead —
 * fixed per `EngineInvocation` closure, identical on every call whether it's
 * the first start or the Nth restart — avoids the race entirely.
 *
 * Used for tenants that don't need the crash-loop behavior (control tenants
 * and the SIGKILL-target tenants, whose only restart is FleetManager's own
 * post-crash auto-restart after the external SIGKILL). Crash-loop tenants
 * use fleet-soak-crashloop-marker-fixture.mjs instead, which bakes in both
 * the marker AND the crash timing.
 *
 * Usage: fleet-soak-marker-fixture.mjs <start|stop> <marker>
 */
const marker = process.argv[3];
if (marker) process.env.FAKE_EXTRA_LINE = marker;
await import("../src/fleet/test-fixtures/fake-engine.mjs");
