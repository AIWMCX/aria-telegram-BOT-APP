import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  EngineCommand,
  EngineState,
  PaperEvent,
  StrategyConfig,
  parseEngineCommand,
  serializeEngineState,
} from "./contracts.js";

const strategy = {
  buyAmountSol: 0.01,
  maxPositions: 3,
  maxSlippageBps: 300,
  stopLossPct: 25,
  takeProfit1Pct: 80,
  takeProfit2Pct: 200,
  trailingStopPct: 15,
  minimumLiquiditySol: 500,
  maximumTokenAgeSeconds: 300,
  safetyFilters: { requireRevokedAuthorities: true, requireSocials: true },
};

assert.equal(StrategyConfig.safeParse(strategy).success, true);
assert.equal(StrategyConfig.safeParse({ ...strategy, buyAmountSol: Number.NaN }).success, false);
assert.equal(StrategyConfig.safeParse({ ...strategy, executionMode: "live" }).success, false);
assert.equal(StrategyConfig.safeParse({ ...strategy, takeProfit2Pct: 50 }).success, false);

const state = {
  status: "stopped" as const,
  network: "unknown" as const,
  publicAddress: null,
  balanceLamports: null,
  licenseStatus: "valid" as const,
  strategy,
  lastHeartbeatAt: null,
  paper: { positions: [], pnlLamports: "0" },
};
assert.equal(EngineState.safeParse(state).success, true);
const serialized = serializeEngineState(state);
assert.equal(serialized.includes("privateKey"), false);
assert.equal(serialized.includes("seedPhrase"), false);

const issuedAt = new Date("2026-08-17T06:00:00.000Z");
const command = {
  id: randomUUID(), type: "stop" as const,
  issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 10_000).toISOString(), payload: null,
};
assert.equal(EngineCommand.safeParse(command).success, true);
assert.equal(parseEngineCommand(command).type, "stop");
assert.throws(() => parseEngineCommand({ ...command, expiresAt: issuedAt.toISOString() }));
assert.equal(EngineCommand.safeParse({ ...command, type: "live_trade" }).success, false);

const event = {
  id: randomUUID(), kind: "paper_filled" as const, occurredAt: issuedAt.toISOString(),
  message: "PAPER fill recorded", paperOnly: true as const,
};
assert.equal(PaperEvent.safeParse(event).success, true);
assert.equal(PaperEvent.safeParse({ ...event, paperOnly: false }).success, false);

console.log("engine contract tests passed");
