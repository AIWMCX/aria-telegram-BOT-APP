import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearStaleEngineLock, ENGINE_LOCK_RELATIVE_PATH } from "../src/fleet/fleet-manager.js";

// Production: after a container restart the engine saw "ARIA is already running (pid 93)" because the
// old lock's pid was reused by an unrelated process. The control plane clears it before spawning.
const rt = mkdtempSync(path.join(os.tmpdir(), "lock-"));
const lock = path.join(rt, ENGINE_LOCK_RELATIVE_PATH);
assert.equal(ENGINE_LOCK_RELATIVE_PATH, path.join("run", "aria.lock"), "lock path matches the engine's LOCK_FILE_PATH (run/aria.lock)");
mkdirSync(path.dirname(lock), { recursive: true });
writeFileSync(lock, "93");
assert.equal(clearStaleEngineLock(rt, "c"), true, "a leftover lock is removed");
assert.equal(existsSync(lock), false, "stale lock gone before spawn");
assert.equal(clearStaleEngineLock(rt, "c"), false, "no lock is a harmless no-op");
console.log("stale engine lock: ok");
