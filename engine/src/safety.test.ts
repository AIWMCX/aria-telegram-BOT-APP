import assert from "node:assert/strict";
import { SafetyLatch } from "./safety.js";

const latch = new SafetyLatch();
assert.equal(latch.isTripped(), false);
latch.trip("user_stop");
latch.trip("fatal_error");
assert.equal(latch.isTripped(), true);
assert.equal(latch.stopReason(), "user_stop");
console.log("safety latch tests passed");
