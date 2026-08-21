import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncCommand, CommandReplayGuard, isExpiredSyncCommand } from "./sync.js";

const base = { commandId: "550e8400-e29b-41d4-a716-446655440000", installationId: "550e8400-e29b-41d4-a716-446655440001", issuedAt: "2026-08-19T12:00:00.000Z", expiresAt: "2026-08-19T12:01:00.000Z", expectedState: "READY" as const, sequence: 1, type: "paper_start" as const, payload: {} };

test("parses an expiring sync command", () => {
  const command = SyncCommand.parse(base);
  assert.equal(command.type, "paper_start");
  assert.equal(isExpiredSyncCommand(command, Date.parse("2026-08-19T12:00:30.000Z")), false);
  assert.equal(isExpiredSyncCommand(command, Date.parse("2026-08-19T12:02:00.000Z")), true);
});

test("rejects replayed or out-of-order commands", () => {
  const guard = new CommandReplayGuard();
  assert.equal(guard.accept(SyncCommand.parse(base)), true);
  assert.equal(guard.accept(SyncCommand.parse(base)), false);
  assert.equal(guard.accept(SyncCommand.parse({ ...base, commandId: "550e8400-e29b-41d4-a716-446655440002", sequence: 1 })), false);
  assert.equal(guard.accept(SyncCommand.parse({ ...base, commandId: "550e8400-e29b-41d4-a716-446655440003", sequence: 2 })), true);
});
