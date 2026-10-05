/**
 * Hosted PAPER Engine, Task 1 (docs/superpowers/plans/2026-09-08-hosted-engine-plan.md,
 * docs/superpowers/specs/2026-09-08-hosted-engine-design.md) — the schema
 * side of "confirm schema and runtime-path plumbing are ready for
 * multi-tenancy".
 *
 * What this adds, and why: `engine_clients` needs a way to know, per
 * paired device, whether it's a hosted process the Fleet Manager (Task 2,
 * not yet built) is responsible for spawning/supervising, or a local-CLI
 * process a user runs themselves — the Fleet Manager must never try to
 * spawn a process for a client_id that's actually running on someone's
 * laptop, and the reverse distinction matters for support/debugging too.
 * `hosting_mode` captures exactly that, additively: it defaults to
 * 'local', so every existing row (every client paired before this
 * program existed) is correctly classified with zero backfill needed and
 * zero behavior change for local-CLI users — the same "additive, never a
 * forced migration" principle the design spec states as a non-goal to
 * violate.
 *
 * What this deliberately does NOT add: a hosted-process-status column
 * (e.g. running/crashed/stopped). The design spec's "Health surface"
 * section is explicit that the Fleet Manager should reuse the SAME
 * `engine_clients.status`/`last_seen_at` columns the sync protocol
 * already writes — "no parallel state model" — and Task 2's own
 * `TenantProcessHandle` interface (pid, restartCount, lastExitCode, etc.)
 * is in-memory supervisor state, not something that belongs in this
 * table; persisting it here now would be exactly the kind of speculative
 * column this task's own instructions warn against adding before the
 * consumer (Task 2) exists to justify its shape. If Task 2's real
 * implementation later finds `status`/`last_seen_at` genuinely
 * insufficient, that's a schema decision for Task 2 to make against real
 * requirements, not one to guess at here.
 */
exports.up = (pgm) => {
  pgm.createType("engine_hosting_mode", ["local", "hosted"]);

  pgm.addColumn("engine_clients", {
    hosting_mode: { type: "engine_hosting_mode", notNull: true, default: "local" },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("engine_clients", "hosting_mode");
  pgm.dropType("engine_hosting_mode");
};
