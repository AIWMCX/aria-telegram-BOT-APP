import assert from "node:assert/strict";
import { AuthenticatedClient } from "./authenticated-client.js";
import { ControlLoop } from "./control-loop.js";
import type { EngineCommand, EngineState } from "./contracts.js";

const strategy = { buyAmountSol: 0.01, maxPositions: 1, maxSlippageBps: 200, stopLossPct: 20, takeProfit1Pct: 80, takeProfit2Pct: 200, trailingStopPct: 10, minimumLiquiditySol: 500, maximumTokenAgeSeconds: 300, safetyFilters: { requireRevokedAuthorities: true, requireSocials: true } };
const state: EngineState = { status: "paper_running", network: "solana-devnet", publicAddress: "So11111111111111111111111111111111111111112", balanceLamports: "42", licenseStatus: "valid", strategy, lastHeartbeatAt: new Date().toISOString(), paper: { positions: [], pnlLamports: "0" } };
const requests: string[] = [];
const transport = async (_url: string, init: RequestInit) => { requests.push(String(init.method)); const body = init.body ? JSON.parse(String(init.body)) : null; const result = String(init.method) === "GET" ? { ok: true, commands: [] } : { ok: true }; return new Response(JSON.stringify(result), { status: 200 }); };
const client = new AuthenticatedClient("https://aria.example.com", "credential-value-123456", transport);
let sleeps = 0;
const loop = new ControlLoop(client, { snapshot: () => state, async applyCommand(_command: EngineCommand) { return { accepted: true }; } }, 0, async () => { sleeps++; loop.stop(); });
await loop.run();
assert.deepEqual(requests, ["POST", "GET"]);
assert.equal(sleeps, 1);
console.log("control loop tests passed");
