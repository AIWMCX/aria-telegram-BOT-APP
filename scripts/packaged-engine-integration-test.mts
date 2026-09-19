/**
 * Production-equivalent integration test for the PACKAGED aria-engine
 * artifact (hosted PAPER engine, Task 7, step 8).
 *
 * WHAT THIS EXISTS TO PROVE: Task 6 certified the Fleet Manager against a
 * FAKE engine fixture (src/fleet/test-fixtures/fake-engine.mjs) and against
 * the DEV SIBLING CHECKOUT path. Neither of those is what ships. This test
 * runs the same class of checks against the REAL artifact produced by
 * scripts/package-engine.mjs — the identical script the Dockerfile's builder
 * stage runs — so a pass here is evidence about the thing that deploys, not
 * about a fixture.
 *
 * Run:
 *   node scripts/package-engine.mjs --sha <40-char> --dest <dir>
 *   ARIA_PACKAGED_ENGINE_PATH=<dir> npx tsx scripts/packaged-engine-integration-test.mts
 *
 * HONEST SCOPE LIMIT — read before quoting a pass from this file:
 * The lifecycle section drives `shadow start`, NOT `paper start`. That is not
 * a convenience choice. aria-engine's `cmdPaperStart` (src/cli.ts) requires
 * BOTH a `pairing-state.json` AND an entitlement token signed by the control
 * plane's ARIA_ENTITLEMENT private key, whose public half is baked into the
 * engine as a constant (src/entitlement-public-key.ts). That private key is a
 * production secret, not available here, and nothing in the hosted flow writes
 * `pairing-state.json` at all today (see the report's Finding P0-2). So a real
 * `paper start` CANNOT reach ONLINE in this environment, and claiming
 * otherwise would be fabricated. `shadow start` is the same packaged binary,
 * the same tsx entrypoint, the same ARIA_RUNTIME_DIR isolation, and the same
 * FleetManager spawn/monitor/restart code — it exercises every part of the
 * packaging and supervision machinery, and stops short only of the
 * entitlement gate. Section 5 below probes that gate explicitly and asserts
 * the exact failure, so the gap is measured rather than glossed over.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetManager, type EngineInvocation } from "../src/fleet/fleet-manager.js";
import { EngineIdentityError } from "../src/fleet/engine-identity.js";
import { resolveEngineIdentity } from "../src/fleet/engine-identity.js";

let failures = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Real OS-level liveness probe. Signal 0 checks existence only; it never kills. */
function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  console.log(`   (timed out after ${timeoutMs}ms waiting for: ${label})`);
  return false;
}

const ENGINE_PATH = process.env.ARIA_PACKAGED_ENGINE_PATH;
if (!ENGINE_PATH) {
  console.error("FATAL: set ARIA_PACKAGED_ENGINE_PATH to the directory produced by scripts/package-engine.mjs");
  process.exit(1);
}
const EXPECTED_SHA = readFileSync(path.join(ENGINE_PATH, ".engine-sha"), "utf8").trim();

console.log(`\n=== Packaged-artifact integration test ===`);
console.log(`engine path : ${ENGINE_PATH}`);
console.log(`engine sha  : ${EXPECTED_SHA}\n`);

// ── 1. Build identity + fail-closed verification ────────────────────────────
console.log("── 1. Engine build identity (src/fleet/engine-identity.ts) ──");
{
  const good = resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: EXPECTED_SHA, NODE_ENV: "production" });
  ok("packaged engine is available", good.available);
  ok("packaged engine is compatible", good.compatible);
  ok("packaged engine reports a real 40-char sha", /^[0-9a-f]{40}$/.test(good.sha ?? ""), good.sha ?? "null");
  ok("reported sha equals the pinned sha", good.sha === EXPECTED_SHA);
  ok("mode is paper", good.mode === "paper");
  ok("no reason string on a healthy engine", good.reason === null);

  // Fail-closed negatives — each must refuse, not degrade quietly.
  const wrongSha = "0".repeat(40);
  const mismatch = resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: wrongSha, NODE_ENV: "production" });
  ok("SHA MISMATCH fails closed (available=false)", !mismatch.available);
  ok("SHA MISMATCH is not reported compatible", !mismatch.compatible);

  const missing = resolveEngineIdentity(path.join(ENGINE_PATH, "__does_not_exist__"), {
    ARIA_ENGINE_COMMIT_SHA: EXPECTED_SHA,
    NODE_ENV: "production",
  });
  ok("MISSING ENGINE TREE fails closed", !missing.available && !missing.compatible);

  const unpinnedProd = resolveEngineIdentity(ENGINE_PATH, { NODE_ENV: "production" });
  ok("UNPINNED IN PRODUCTION fails closed (packaging step did not run)", !unpinnedProd.available);

  const unpinnedDev = resolveEngineIdentity(ENGINE_PATH, { NODE_ENV: "development" });
  ok("UNPINNED IN LOCAL DEV stays usable (sibling checkout unbroken)", unpinnedDev.available);
  ok("UNPINNED IN LOCAL DEV is honestly not 'compatible'", !unpinnedDev.compatible && !unpinnedDev.verified);
}

// ── 2. LIVE-capability scan of the packaged artifact ────────────────────────
// Any LIVE execution capability inside the shipped artifact is an immediate,
// reportable failure per the program's PAPER-only constraint — not something
// to quietly fix.
console.log("\n── 2. PAPER-only assertion on the packaged artifact ──");
{
  const pkg = JSON.parse(readFileSync(path.join(ENGINE_PATH, "package.json"), "utf8")) as {
    description?: string;
    dependencies?: Record<string, string>;
  };
  ok(
    "packaged package.json declares PAPER-ONLY",
    (pkg.description ?? "").includes("PAPER-ONLY"),
    pkg.description?.slice(0, 60),
  );
  ok(
    "packaged engine has ZERO runtime dependencies (no @solana/web3.js, no wallet/signing libs)",
    Object.keys(pkg.dependencies ?? {}).length === 0,
    JSON.stringify(pkg.dependencies ?? {}),
  );

  // Source-level scan for real signing/broadcast CAPABILITY. Two exclusions,
  // both established by inspecting the actual hits rather than assumed:
  //   • `*.test.ts` is skipped because aria-engine's own guard tests
  //     (src/contracts.test.ts, src/paper/paper-hard-stop.test.ts) contain
  //     these identifiers inside their FORBIDDEN_PATTERNS lists — i.e. as
  //     negative assertions enforcing exactly this property. Flagging the
  //     enforcement mechanism as a violation is a false positive.
  //   • Comments are stripped because src/contracts.ts's header names
  //     `signTransaction` only to state that no such concept exists in the
  //     file. Prose about absence is not capability.
  // Verified after the exclusions: zero occurrences remain in executable code.
  const banned = ["sendTransaction", "signTransaction", "Keypair.fromSecretKey", "sendRawTransaction", "mnemonicToSeed"];
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const text = stripComments(readFileSync(p, "utf8"));
        for (const b of banned) if (text.includes(b)) hits.push(`${path.relative(ENGINE_PATH, p)}:${b}`);
      }
    }
  };
  walk(path.join(ENGINE_PATH, "src"));
  ok("no transaction-signing/broadcast capability in packaged executable src/", hits.length === 0, hits.join(", ") || "clean");
  ok(
    "packaged engine ships its OWN forbidden-capability guard tests",
    existsSync(path.join(ENGINE_PATH, "src", "paper", "paper-hard-stop.test.ts")) &&
      readFileSync(path.join(ENGINE_PATH, "src", "paper", "paper-hard-stop.test.ts"), "utf8").includes("sendRawTransaction"),
  );
}

// ── 3. FleetManager lifecycle against the PACKAGED artifact ─────────────────
console.log("\n── 3. Fleet lifecycle against the packaged artifact (real OS processes) ──");

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "aria-packaged-it-"));
const tenantsRoot = path.join(tmpRoot, "tenants");
const logsRoot = path.join(tmpRoot, "logs");

/**
 * Mirrors src/fleet/fleet-manager.ts's `realEngineInvocation()` EXACTLY —
 * same executable (`process.execPath`), same `--import tsx` flag, same
 * `src/cli.ts` entrypoint, same cwd (the packaged engine directory). The only
 * difference is the subcommand, for the entitlement reason documented in this
 * file's header. If `realEngineInvocation`'s shape ever changes, this must
 * change with it — asserted immediately below so the two cannot drift silently.
 */
const shadowInvocation: EngineInvocation = {
  buildStart: () => ({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "shadow", "start"],
    cwd: ENGINE_PATH,
  }),
  buildStop: () => ({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "shadow", "stop"],
    cwd: ENGINE_PATH,
  }),
  readyMarker: "shadow mode started",
};
{
  const { realEngineInvocation } = await import("../src/fleet/fleet-manager.js");
  const real = realEngineInvocation(ENGINE_PATH).buildStart();
  const mine = shadowInvocation.buildStart();
  ok("test invocation matches realEngineInvocation's executable", real.command === mine.command);
  ok("test invocation matches realEngineInvocation's cwd (the PACKAGED path, not the dev sibling)", real.cwd === mine.cwd && real.cwd === ENGINE_PATH);
  ok(
    "test invocation matches realEngineInvocation's tsx/src/cli.ts entrypoint",
    real.args.slice(0, 3).join(" ") === mine.args.slice(0, 3).join(" "),
    real.args.join(" "),
  );
}

const fm = new FleetManager({
  engineInvocation: shadowInvocation,
  verifyEngineIdentity: () => resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: EXPECTED_SHA }),
  tenantsRoot,
  logsRoot,
  restartBackoffMs: 1000,
  sustainedHealthyMs: 500,
});

const pidsSeen = new Set<number>();
try {
  // 3a. Spawn A and B, both ONLINE.
  const a = await fm.spawnTenant("tenant-A");
  const b = await fm.spawnTenant("tenant-B");
  const bothOnline = await waitFor(
    "tenant A and B both running",
    () => fm.getTenantStatus("tenant-A")?.status === "running" && fm.getTenantStatus("tenant-B")?.status === "running",
    90_000,
  );
  ok("tenant A reached ONLINE from the packaged artifact", fm.getTenantStatus("tenant-A")?.status === "running");
  ok("tenant B reached ONLINE from the packaged artifact", fm.getTenantStatus("tenant-B")?.status === "running");
  if (!bothOnline) throw new Error("tenants did not reach running — aborting lifecycle section");

  const pidA1 = fm.getTenantStatus("tenant-A")!.pid!;
  const pidB = fm.getTenantStatus("tenant-B")!.pid!;
  pidsSeen.add(pidA1);
  pidsSeen.add(pidB);

  // 3b. REAL isolation checks — OS-level and on-disk, not in-memory bookkeeping.
  ok("A and B are distinct OS processes", pidA1 !== pidB, `A=${pidA1} B=${pidB}`);
  ok("A's pid is genuinely alive (kill(pid,0))", pidAlive(pidA1));
  ok("B's pid is genuinely alive (kill(pid,0))", pidAlive(pidB));

  const dirA = fm.runtimeDirFor("tenant-A");
  const dirB = fm.runtimeDirFor("tenant-B");
  ok("A and B have distinct runtime directories", dirA !== dirB);
  ok("A's runtime dir really exists on disk", existsSync(dirA), dirA);
  ok("B's runtime dir really exists on disk", existsSync(dirB), dirB);
  ok("A's engine wrote its own config.json under A's dir", existsSync(path.join(dirA, "config.json")));
  ok("B's engine wrote its own config.json under B's dir", existsSync(path.join(dirB, "config.json")));
  // NOT asserted: a per-tenant `run/aria.lock`. Verified in the packaged
  // engine's src/cli.ts — `acquireLock()` is called by `cmdPaperStart` only,
  // never by `cmdShadowStart`, so no lock file exists in this lifecycle by
  // design. Asserting one here would fail for a reason that has nothing to do
  // with packaging or isolation. The single-instance lock's own per-tenant
  // correctness is covered by aria-engine's src/runtime/single-instance.test.ts
  // and by the fleet's dual-mode-coexistence test; what THIS test proves is
  // that each tenant gets a genuinely separate runtime directory, which the
  // config.json / marker-leak assertions above and below establish directly.
  ok(
    "neither tenant's runtime dir is the engine's default ~/.aria (ARIA_RUNTIME_DIR really took effect)",
    !dirA.includes(path.join(os.homedir(), ".aria")) && !dirB.includes(path.join(os.homedir(), ".aria")),
  );

  // A per-tenant marker written into A's dir must never appear in B's — proves
  // ARIA_RUNTIME_DIR isolation is real filesystem separation, not a label.
  writeFileSync(path.join(dirA, "isolation-marker-A.txt"), "A", "utf8");
  ok("A's marker does NOT leak into B's runtime dir", !existsSync(path.join(dirB, "isolation-marker-A.txt")));

  const logA = path.join(logsRoot, "tenant-A.log");
  const logB = path.join(logsRoot, "tenant-B.log");
  ok("A and B have separate log files", existsSync(logA) && existsSync(logB) && logA !== logB);
  ok(
    "A's log contains the packaged engine's own ready marker (the real binary ran)",
    readFileSync(logA, "utf8").includes("shadow mode started"),
  );

  // 3c. SIGKILL tenant A — B must be unaffected, A must auto-recover.
  console.log(`   … SIGKILL tenant-A (pid ${pidA1})`);
  process.kill(pidA1, "SIGKILL");
  await waitFor("A's pid to die", () => !pidAlive(pidA1), 15_000);
  ok("SIGKILLed A's process is actually gone", !pidAlive(pidA1));
  ok("B is UNAFFECTED by A's kill (still alive at OS level)", pidAlive(pidB));
  ok("B is UNAFFECTED by A's kill (still 'running' to the fleet)", fm.getTenantStatus("tenant-B")?.status === "running");

  const recovered = await waitFor(
    "A to auto-recover to running",
    () => fm.getTenantStatus("tenant-A")?.status === "running" && fm.getTenantStatus("tenant-A")?.pid !== pidA1,
    90_000,
  );
  ok("A auto-recovered after SIGKILL", recovered);
  const pidA2 = fm.getTenantStatus("tenant-A")?.pid;
  if (pidA2) pidsSeen.add(pidA2);
  ok("A recovered as a NEW process, not the dead pid", pidA2 !== undefined && pidA2 !== pidA1, `old=${pidA1} new=${pidA2}`);
  ok("A's recovered pid is genuinely alive", pidAlive(pidA2));
  ok("A's restartCount incremented", (fm.getTenantStatus("tenant-A")?.restartCount ?? 0) >= 1);

  // 3d. Stop both, then assert ZERO orphans at OS level.
  await fm.stopTenant("tenant-A", false);
  await fm.stopTenant("tenant-B", false);
  await waitFor(
    "both tenants stopped",
    () => fm.getTenantStatus("tenant-A")?.status === "stopped" && fm.getTenantStatus("tenant-B")?.status === "stopped",
    30_000,
  );
  ok("A is stopped", fm.getTenantStatus("tenant-A")?.status === "stopped");
  ok("B is stopped", fm.getTenantStatus("tenant-B")?.status === "stopped");

  await sleep(1500);
  const orphans = [...pidsSeen].filter((p) => pidAlive(p));
  ok("ZERO orphaned engine processes remain", orphans.length === 0, orphans.length ? `orphans: ${orphans.join(", ")}` : "none");
  ok("fleet reports no active tenants", fm.listActiveTenants().length === 0);

  // 3e. Spawn-time gate must refuse a mismatched engine, with no process created.
  const gated = new FleetManager({
    engineInvocation: shadowInvocation,
    verifyEngineIdentity: () => resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: "0".repeat(40) }),
    tenantsRoot,
    logsRoot,
  });
  let threw: unknown;
  try {
    await gated.spawnTenant("tenant-C");
  } catch (e) {
    threw = e;
  }
  ok("spawnTenant REJECTS a version-mismatched engine", threw instanceof EngineIdentityError);
  ok("rejected spawn created NO tenant entry at all", gated.getTenantStatus("tenant-C") === undefined);
} finally {
  for (const p of pidsSeen) {
    try {
      if (pidAlive(p)) process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ── 4. `paper start` entitlement-gate probe ─────────────────────────────────
// Measures the real blocker rather than asserting the hosted path works.
console.log("\n── 4. Real `paper start` gate probe (packaged artifact) ──");
{
  const probeDir = path.join(tmpRoot, "paper-probe");
  let output = "";
  try {
    output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "paper", "start"], {
      cwd: ENGINE_PATH,
      env: { ...process.env, ARIA_RUNTIME_DIR: probeDir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  ok(
    "packaged engine's `paper start` LOADS (tsx + src/cli.ts resolve from the packaged tree)",
    output.includes("configuration") || output.includes("paired") || output.includes("entitlement"),
    output.trim().split("\n").slice(-1)[0],
  );
  ok(
    "packaged engine honors ARIA_RUNTIME_DIR for `paper start` (wrote config into the tenant dir)",
    existsSync(path.join(probeDir, "config.json")),
  );
  ok(
    "`paper start` is blocked at the PAIRING/ENTITLEMENT gate, not at packaging (documents Finding P0-2)",
    output.includes("not paired") || output.includes("entitlement"),
    output.trim().split("\n").slice(-1)[0],
  );
}

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "✅ all packaged-artifact assertions passed" : `❌ ${failures} assertion(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
