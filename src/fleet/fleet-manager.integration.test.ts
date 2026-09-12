/**
 * REAL-CLI integration test for FleetManager — spawns the ACTUAL
 * aria-engine `cli.ts` (unmodified, via `node --import tsx`, no build
 * step needed since aria-engine's own `npm start` does the same) from
 * the sibling checkout at `C:\Users\AIWMC\dev\aria-engine`, which must be
 * on (or built from) the `feat/hosted-runtime-dir-override` branch —
 * that's where `ARIA_RUNTIME_DIR` support lives (see Task 1's ledger
 * entry). This is deliberately separate from fleet-manager.test.ts so the
 * fast fake-fixture suite never depends on a sibling repo's checkout
 * state or takes on process-spawn flakiness.
 *
 * IMPORTANT — documented, not silently worked around: this test does NOT
 * reach a "running" `paper start` against the real binary, and cannot,
 * in this environment. Investigated directly (see below) rather than
 * assumed:
 *
 *   `aria paper start` is gated behind TWO checks before it does
 *   anything else: (1) `loadPairingState()` — must have already run
 *   `aria pair <CODE>` against the real control plane, and (2)
 *   `checkPaperStartEntitlement()` (entitlement-gate.ts), which verifies
 *   an Ed25519-signed ARIAE1 token against `ARIA_ENTITLEMENT_PUBLIC_X`, a
 *   constant BAKED INTO aria-engine's compiled source
 *   (entitlement-public-key.ts) — not injectable from a CLI flag, env
 *   var, or test-only override at the `cli.ts` call site (only the pure
 *   `checkPaperStartEntitlement`/`verifyEntitlement` FUNCTIONS take an
 *   injectable public key, for aria-engine's own unit tests — cli.ts
 *   itself always calls them with the real default). The matching
 *   PRIVATE key (`ARIA_ENTITLEMENT_PRIVATE_D`) lives only in this repo's
 *   production Railway environment (`src/engine-entitlement-signer.ts`)
 *   — it is not in this dev checkout's `.env` (confirmed: no `.env` file
 *   exists in this worktree) and must never be committed or faked, since
 *   the entire point of the entitlement design is that only the real
 *   control plane can mint a token aria-engine will accept. Forging one
 *   here would either require the real secret (not available, by
 *   design) or modifying aria-engine's baked-in public key/gate logic
 *   (explicitly out of scope — the plan states `ARIA_RUNTIME_DIR` is "the
 *   ONLY aria-engine change this whole program should need").
 *
 *   Verified directly (see the two manual runs this test also encodes
 *   below): `ARIA_RUNTIME_DIR` override works correctly against the real
 *   binary (config.json is created under the overridden path, not
 *   `~/.aria`), and an unpaired `paper start` fails closed immediately
 *   with `"Device is not paired. Run \`aria pair <CODE>\` first."`,
 *   exit code 1 — exactly the fail-closed behavior the entitlement
 *   design promises, and exactly what this test asserts FleetManager
 *   handles correctly (never reports "running" for a process that never
 *   printed the ready marker; correctly classifies the nonzero exit as
 *   `crashed`, not `stopped`).
 *
 *   Full "reaches running" happy-path proof against the real binary is
 *   covered instead by the FAKE fixture in fleet-manager.test.ts, which
 *   mirrors the real engine's actual desired-state stop protocol
 *   faithfully (see that fixture's own docblock) specifically so the
 *   state-machine and stop-mechanism logic under test is not a toy. A
 *   genuine end-to-end "real binary reaches running" test needs a
 *   real-control-plane-issued entitlement for a real paired device —
 *   that belongs in a staging/CI environment that HAS the production (or
 *   a dedicated staging) entitlement key, which this dev worktree
 *   intentionally does not.
 *
 * Run: npx tsx src/fleet/fleet-manager.integration.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetManager, realEngineInvocation } from "./fleet-manager.js";

const ENGINE_REPO = "C:\\Users\\AIWMC\\dev\\aria-engine";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function main() {
  if (!fs.existsSync(path.join(ENGINE_REPO, "src", "cli.ts"))) {
    console.log(`⚠ skipping: aria-engine checkout not found at ${ENGINE_REPO} — cannot run the real-CLI integration test in this environment.`);
    process.exit(0);
  }

  const tenantsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-int-tenants-"));
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-int-logs-"));
  const fm = new FleetManager({
    engineInvocation: realEngineInvocation(ENGINE_REPO),
    tenantsRoot,
    logsRoot,
    restartBackoffMs: 100000, // don't let the crash-restart policy fire mid-assertion; we want to observe the FIRST "crashed" state cleanly
  });

  const clientId = "integration-tenant-unpaired";
  const runtimeDir = path.join(tenantsRoot, clientId, ".aria");

  const handle = await fm.spawnTenant(clientId);
  check("handle created immediately with a pid", typeof handle.pid === "number");

  const reachedCrashed = await waitFor(() => fm.getTenantStatus(clientId)?.status === "crashed");
  check("real unpaired CLI exits nonzero and FleetManager classifies it as crashed (fail-closed, not falsely 'running')", reachedCrashed);
  check("FleetManager never reported this tenant as running (no ready marker was ever printed by a fail-closed process)", fm.getTenantStatus(clientId)?.status !== "running");
  check("lastExitCode is the real CLI's nonzero exit (fail() calls process.exit(1))", fm.getTenantStatus(clientId)?.lastExitCode === 1);

  check("the REAL binary created the tenant-scoped runtime dir under our override (proves ARIA_RUNTIME_DIR threads through end-to-end)", fs.existsSync(runtimeDir));
  check("the REAL binary wrote its own config.json into the tenant-scoped dir, not ~/.aria", fs.existsSync(path.join(runtimeDir, "config.json")));

  const logPath = path.join(logsRoot, `${clientId}.log`);
  await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").length > 0);
  const logContent = fs.readFileSync(logPath, "utf8");
  check("the per-tenant log file captured the real CLI's actual fail-closed message", logContent.includes("not paired"));

  // stopTenant on this never-successfully-running (crashed) tenant must
  // still be a safe no-op — nothing to stop, no hang.
  let threw = false;
  try {
    await fm.stopTenant(clientId, true);
  } catch {
    threw = true;
  }
  check("stopTenant on a crashed-and-not-restarted tenant does not throw or hang", !threw);

  console.log(`\n${failures === 0 ? "✅ ALL PASSED" : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("fleet-manager.integration.test.ts crashed:", err);
  process.exit(1);
});
