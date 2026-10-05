#!/usr/bin/env node
/**
 * Test-only stand-in for aria-engine's `aria paper start|stop`, used by
 * fleet-manager.test.ts / tenant-process.test.ts so unit tests never spawn
 * the real CLI (that's the job of the real-CLI integration test in
 * fleet-manager.integration.test.ts).
 *
 * Deliberately mirrors the REAL engine's actual stop mechanism as
 * documented in aria-engine's cli.ts (`requestDesiredState` /
 * `readDesiredState`, see `runtime/control.ts`): `stop` does NOT signal a
 * running process directly — it writes a "desired state" file under
 * ARIA_RUNTIME_DIR that a separately-running `start` process polls. This
 * lets FleetManager's real stopTenant() graceful-stop-then-fallback-kill
 * logic be exercised faithfully against a fake that behaves the same way
 * the real thing does, instead of a fake that trivializes the problem.
 *
 * Env knobs read by `start`:
 *   FAKE_EXIT_CODE      - exit code used for a scheduled/immediate crash (default 1)
 *   FAKE_CRASH_AFTER_MS - if set, the process exits(FAKE_EXIT_CODE) after this delay
 *                         instead of running until told to stop (simulates a crash)
 *   FAKE_FAIL_ON_START  - if "1", exits(FAKE_EXIT_CODE) immediately instead of
 *                         printing the ready line (simulates "never became healthy")
 *   FAKE_EXTRA_LINE     - if set, printed to stdout right after the ready marker —
 *                         used by cross-contamination tests to give each tenant's
 *                         process a distinctive, greppable line in its own log file
 */
import fs from "node:fs";
import path from "node:path";

const cmd = process.argv[2];
const runtimeDir = process.env.ARIA_RUNTIME_DIR;
if (!runtimeDir) {
  console.error("fake-engine: ARIA_RUNTIME_DIR not set");
  process.exit(1);
}
fs.mkdirSync(runtimeDir, { recursive: true });
const desiredPath = path.join(runtimeDir, "desired-state");
const lockPath = path.join(runtimeDir, "lock");

function clearLock() {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

if (cmd === "stop") {
  // Real cmdPaperControl: only meaningful if a process holds the lock;
  // otherwise it's a safe no-op from the CLI's own point of view.
  if (fs.existsSync(lockPath)) fs.writeFileSync(desiredPath, "stopped");
  process.exit(0);
} else if (cmd === "start") {
  if (fs.existsSync(lockPath)) {
    // Mirrors the real engine's single-instance lock semantics: a lock
    // file left behind by a process that no longer exists (e.g. it was
    // SIGKILLed and never got to clean up) is stale, not a real conflict
    // — liveness is checked via the recorded pid, not just file presence.
    const heldPid = Number(fs.readFileSync(lockPath, "utf8"));
    let stillAlive = true;
    try {
      process.kill(heldPid, 0);
    } catch {
      stillAlive = false;
    }
    if (stillAlive) {
      console.error(`fake-engine: already running (pid ${heldPid})`);
      process.exit(1);
    }
    clearLock();
  }

  const exitCode = Number(process.env.FAKE_EXIT_CODE ?? 1);
  if (process.env.FAKE_FAIL_ON_START === "1") {
    process.exit(exitCode);
  }

  fs.writeFileSync(lockPath, String(process.pid));
  fs.writeFileSync(desiredPath, "running");
  console.log("paper engine started (FAKE fixture)");
  if (process.env.FAKE_EXTRA_LINE) console.log(process.env.FAKE_EXTRA_LINE);

  let stopped = false;
  const shutdown = (code) => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearLock();
    process.exit(code);
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));

  const crashAfterMs = process.env.FAKE_CRASH_AFTER_MS ? Number(process.env.FAKE_CRASH_AFTER_MS) : null;
  if (crashAfterMs !== null) setTimeout(() => shutdown(exitCode), crashAfterMs);

  const poll = setInterval(() => {
    try {
      if (fs.readFileSync(desiredPath, "utf8").trim() === "stopped") shutdown(0);
    } catch { /* file briefly missing, ignore */ }
  }, 30);
} else {
  console.error("usage: fake-engine.mjs start|stop");
  process.exit(1);
}
