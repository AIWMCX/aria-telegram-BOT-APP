import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CustomerRuntime } from "./runtime.js";

test("runtime persists paper lifecycle and recovers after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aria-runtime-"));
  try {
    const first = new CustomerRuntime({ stateFile: join(dir, "state.json"), lockFile: join(dir, "runtime.lock") });
    assert.equal((await first.status()).state, "UNCONFIGURED");
    await first.setup();
    assert.equal((await first.status()).state, "READY");
    await first.startPaper();
    assert.equal((await first.status()).state, "PAPER_RUNNING");
    await first.release();
    const second = new CustomerRuntime({ stateFile: join(dir, "state.json"), lockFile: join(dir, "runtime.lock") });
    assert.equal((await second.status()).state, "PAPER_RUNNING");
    await second.stop();
    assert.equal((await second.status()).state, "STOPPED");
    await second.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime lock prevents a second active instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aria-runtime-lock-"));
  try {
    const first = new CustomerRuntime({ stateFile: join(dir, "state.json"), lockFile: join(dir, "runtime.lock") });
    const second = new CustomerRuntime({ stateFile: join(dir, "state.json"), lockFile: join(dir, "runtime.lock") });
    await first.acquire();
    await assert.rejects(() => second.acquire(), /already running/);
    await first.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
