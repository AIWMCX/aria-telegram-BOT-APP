#!/usr/bin/env node
/**
 * Wrapper around src/fleet/test-fixtures/fake-engine.mjs that hardcodes
 * FAKE_CRASH_AFTER_MS for EVERY invocation (initial start AND every
 * subsequent auto-restart), used only by scripts/fleet-soak.ts's
 * "crash-loop" tenants.
 *
 * Why this exists (a real bug found and fixed during the Task 6 soak,
 * documented here rather than silently worked around): the soak script's
 * first attempt set `process.env.FAKE_CRASH_AFTER_MS` once, synchronously,
 * right before the INITIAL spawnTenant() call for each crash-loop tenant,
 * then cleared it once every tenant had been spawned. That correctly
 * crashed the tenant's FIRST run, but FleetManager's own auto-restart
 * (fired later, from an internal setTimeout, long after the soak script's
 * spawn loop had already cleared the env var) spawned the RESTART with a
 * clean environment — so the restarted process never crashed again and
 * looked "recovered" after exactly one crash, when the intent was to
 * observe the FULL exponential-backoff-then-give-up escalation under real
 * concurrent load. This wrapper fixes that by baking the crash behavior
 * into the fixture's OWN environment at the top of every fresh process
 * invocation (start or stop), independent of the soak script's
 * long-since-cleared `process.env` at restart time.
 */
process.env.FAKE_CRASH_AFTER_MS = process.env.SOAK_CRASHLOOP_MS ?? "1500";
await import("../src/fleet/test-fixtures/fake-engine.mjs");
