import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PaperEngine } from "./paper.js";
import { type StrategyConfig } from "./contracts.js";

const strategy: StrategyConfig = { buyAmountSol: 0.01, maxPositions: 1, maxSlippageBps: 200, stopLossPct: 20, takeProfit1Pct: 80, takeProfit2Pct: 200, trailingStopPct: 10, minimumLiquiditySol: 500, maximumTokenAgeSeconds: 300, safetyFilters: { requireRevokedAuthorities: true, requireSocials: true } };
const started = new PaperEngine(strategy, () => "valid");
await started.start();
const event = started.tick({ symbol: "TEST", mint: "So11111111111111111111111111111111111111112", detectedAt: new Date().toISOString() });
assert.equal(event[0]!.paperOnly, true);
assert.equal(started.snapshot().paper.positions.length, 1);
const stop = { id: randomUUID(), type: "stop" as const, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString(), payload: null };
assert.equal((await started.applyCommand(stop)).accepted, true);
assert.equal((await started.applyCommand({ ...stop, id: randomUUID(), type: "start_paper" })).accepted, false);
console.log("paper engine tests passed");
