/**
 * REAL end-to-end rehydration check against the PACKAGED aria-engine.
 *
 * Run:
 *   node scripts/package-engine.mjs --sha <40> --url <repo> --dest <dir>
 *   ARIA_PACKAGED_ENGINE_PATH=<dir> npx tsx scripts/packaged-engine-rehydration-test.mts
 *
 * Same honest scope as packaged-engine-integration-test.mts: drives
 * `shadow start` (the packaged binary, real tsx entrypoint, real
 * ARIA_RUNTIME_DIR isolation), NOT `paper start`, because a real paper start
 * needs a control-plane-signed entitlement. Everything this feature adds
 * (desired state, rehydration, shutdownAll, orphan check) is engine-agnostic.
 *
 * Flow: start 2 tenants -> "restart the control plane" by shutting down the
 * first FleetManager (shutdownAll) and constructing a NEW one over the same
 * tenantsRoot -> rehydrateTenants -> both return as NEW pids -> shutdownAll
 * leaves zero orphans.
 */
import { readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetManager, type EngineInvocation } from "../src/fleet/fleet-manager.js";
import { resolveEngineIdentity } from "../src/fleet/engine-identity.js";
import { TenantRehydrator } from "../src/fleet/rehydrator.js";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(200);
  }
  return pred();
}

const ENGINE_PATH = process.env.ARIA_PACKAGED_ENGINE_PATH;
if (!ENGINE_PATH) {
  console.error("FATAL: set ARIA_PACKAGED_ENGINE_PATH");
  process.exit(1);
}
const SHA = readFileSync(path.join(ENGINE_PATH, ".engine-sha"), "utf8").trim();
const inv: EngineInvocation = {
  buildStart: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "shadow", "start"], cwd: ENGINE_PATH }),
  buildStop: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "shadow", "stop"], cwd: ENGINE_PATH }),
  readyMarker: "shadow mode started",
};
const tmp = mkdtempSync(path.join(os.tmpdir(), "aria-rehydrate-e2e-"));
const make = () =>
  new FleetManager({
    engineInvocation: inv,
    verifyEngineIdentity: () => resolveEngineIdentity(ENGINE_PATH, { ARIA_ENGINE_COMMIT_SHA: SHA }),
    tenantsRoot: path.join(tmp, "tenants"),
    logsRoot: path.join(tmp, "logs"),
  });

const ids = ["e2e-A", "e2e-B"];
let fm1 = make();
let fm2: FleetManager | undefined;
try {
  for (const id of ids) await fm1.spawnTenant(id);
  ok("two tenants ONLINE from the packaged artifact", await waitFor(() => ids.every((i) => fm1.getTenantStatus(i)?.status === "running"), 90_000));
  const oldPids = ids.map((i) => fm1.getTenantStatus(i)!.pid!);

  // "control plane restarts": graceful shutdown, then a brand-new manager.
  const t0 = Date.now();
  const res = await fm1.shutdownAll({ timeoutMs: 8000 });
  ok("shutdownAll stopped both real engines within budget", Date.now() - t0 < 8000 && res.remaining === 0, `${Date.now() - t0}ms, ${JSON.stringify(res)}`);
  ok("old pids are gone (zero orphans after shutdown)", oldPids.every((p) => !alive(p)));
  ok("desired state survived shutdown (still running)", ids.every((i) => fm1.getDesiredState(i) === "running"));

  fm2 = make();
  ok("new manager starts with an empty in-memory map", ids.every((i) => fm2!.getTenantStatus(i) === undefined));
  const rh = new TenantRehydrator({
    fleet: fm2,
    getClientById: async (id) => ({ id, user_id: 1, status: "active", hosting_mode: "hosted" }),
    isUserApproved: async () => true,
    renewHostedEntitlementIfNeeded: async () => {},
    staggerMs: 300,
  });
  await rh.rehydrateTenants();
  ok("both tenants rehydrated and ONLINE", await waitFor(() => ids.every((i) => fm2!.getTenantStatus(i)?.status === "running"), 90_000));
  const newPids = ids.map((i) => fm2!.getTenantStatus(i)!.pid!);
  ok("rehydrated tenants are NEW processes (new pids)", newPids.every((p, i) => p !== oldPids[i] && alive(p)), `old=${oldPids} new=${newPids}`);
  ok("healthz-style counts report 2 running, 0 queued", rh.counts().running === 2 && rh.counts().queued === 0);

  const res2 = await fm2.shutdownAll({ timeoutMs: 8000 });
  await sleep(300);
  ok("final shutdownAll leaves zero orphans", res2.remaining === 0 && newPids.every((p) => !alive(p)), JSON.stringify(res2));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  fm1.killAllSync();
  fm2?.killAllSync();
}
console.log(failures === 0 ? "\nREAL rehydration E2E passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
