import assert from "node:assert/strict";
import { realEngineInvocation, ENGINE_READY_MARKER } from "../src/fleet/fleet-manager.js";

const marker = realEngineInvocation("/opt/aria-engine").readyMarker;
assert.equal(marker, ENGINE_READY_MARKER);
// Real first lines printed by the engine (legacy paper engine and the PR D sniper, engine 4fadcd3).
assert.ok("11:53:34 INFO  paper engine started (PAPER ONLY)".includes(marker), "legacy engine line marks ready");
assert.ok("11:53:34 INFO  paper sniper engine started (PAPER ONLY; ledger /data/...)".includes(marker), "paper sniper line marks ready");
assert.ok(!"✗ ARIA is already running (pid 93).".includes(marker), "a refusal line does not mark ready");
console.log("engine ready marker: ok");
