#!/usr/bin/env node
/**
 * Additive sibling of fleet-soak-crashloop-fixture.mjs (that file is left
 * COMPLETELY UNTOUCHED — its crash-loop escalation mechanism was
 * independently verified correct by review and this task was explicitly
 * told not to touch it). This wrapper exists because the soak's 2
 * crash-loop tenants ALSO need a genuinely distinctive per-tenant log
 * marker (see fleet-soak-marker-fixture.mjs's docblock for the full
 * rationale — the same argv-baking technique is required so the marker
 * survives every one of a crash-loop tenant's several auto-restarts, not
 * just its first crash).
 *
 * Duplicates (does not modify) the original fixture's own
 * `FAKE_CRASH_AFTER_MS`-baking line so the crash-loop behavior stays
 * byte-for-byte identical to the already-verified mechanism, and adds the
 * marker-baking line alongside it.
 *
 * Usage: fleet-soak-crashloop-marker-fixture.mjs <start|stop> <marker>
 * Env: SOAK_CRASHLOOP_MS (optional, default 1500ms) — same knob as the
 *      original fleet-soak-crashloop-fixture.mjs.
 */
const marker = process.argv[3];
if (marker) process.env.FAKE_EXTRA_LINE = marker;
process.env.FAKE_CRASH_AFTER_MS = process.env.SOAK_CRASHLOOP_MS ?? "1500";
await import("../src/fleet/test-fixtures/fake-engine.mjs");
