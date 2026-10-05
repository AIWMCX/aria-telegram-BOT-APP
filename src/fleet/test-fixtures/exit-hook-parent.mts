// Test-only: a "control plane" that spawns a tenant and then exits via
// process.exit(0) WITHOUT calling shutdownAll, to prove the 'exit' hook kills
// the child. Prints the child's pid on stdout.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { FleetManager } from "../fleet-manager.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exit-hook-"));
const fm = new FleetManager({
  engineInvocation: {
    buildStart: () => ({ command: process.execPath, args: [path.join(dir, "fake-engine.mjs"), "start"], cwd: dir }),
    buildStop: () => ({ command: process.execPath, args: [path.join(dir, "fake-engine.mjs"), "stop"], cwd: dir }),
    readyMarker: "paper engine started",
  },
  tenantsRoot: root,
  logsRoot: path.join(root, "logs"),
});
const h = await fm.spawnTenant("orphan-test");
console.log(`PID=${h.pid}`);
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
