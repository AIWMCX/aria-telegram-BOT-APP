import assert from "node:assert/strict";
import { MarketPaperSession } from "./market-paper-session.js";
import type { ReadOnlyPriceSource, SourceQuote } from "./canonical-quote.js";
import { PaperEngine } from "./paper.js";
import type { StrategyConfig } from "./contracts.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = 1_000_000;
const strategy: StrategyConfig = {
  buyAmountSol: 0.01,
  maxPositions: 2,
  maxSlippageBps: 200,
  stopLossPct: 20,
  takeProfit1Pct: 80,
  takeProfit2Pct: 200,
  trailingStopPct: 10,
  minimumLiquiditySol: 0,
  maximumTokenAgeSeconds: 300,
  safetyFilters: { requireRevokedAuthorities: false, requireSocials: false },
};

function source(source: "jupiter-price" | "raydium-price", usdPrice: string, solUsdPrice = "100"): ReadOnlyPriceSource {
  return {
    source,
    async read(mint: string): Promise<SourceQuote> {
      return { mint, usdPrice, solUsdPrice, source, receivedAtMs: NOW, sourceLatencyMs: 20, observedAtSlot: 123 };
    },
  };
}

{
  const paper = new PaperEngine(strategy, () => "valid", undefined, () => new Date(NOW));
  await paper.start();
  const session = new MarketPaperSession({
    sources: [source("jupiter-price", "1"), source("raydium-price", "1")],
    paper,
    nowMs: () => NOW,
    maxDeviationBps: 100,
  });
  const result = await session.open({ symbol: "USDC", mint: MINT, detectedAt: new Date(NOW).toISOString() });
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("expected accepted result");
  assert.equal(result.quote.lamportsPerWholeToken, 10_000_000n); // $1 / $100 SOL = 0.01 SOL
  assert.equal(result.quote.confidence, "primary");
  assert.equal(result.events[0]!.kind, "paper_filled");
  const position = paper.snapshot().paper.positions[0]!;
  assert.equal(position.entryLamports, "10000000");
  assert.equal(position.quantity, "1000000000"); // 1 whole token at 9-decimal paper precision
  assert.equal(position.entryPriceLamportsPerWholeToken, "10000000");
}

{
  const paper = new PaperEngine(strategy, () => "valid", undefined, () => new Date(NOW));
  await paper.start();
  const session = new MarketPaperSession({
    sources: [source("jupiter-price", "1"), source("raydium-price", "1.10")],
    paper,
    nowMs: () => NOW,
    maxDeviationBps: 100,
  });
  const result = await session.open({ symbol: "USDC", mint: MINT, detectedAt: new Date(NOW).toISOString() });
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") throw new Error("expected rejected result");
  assert.equal(result.reason, "disagreement-exceeds-threshold");
  assert.equal(paper.snapshot().paper.positions.length, 0);
}

{
  const unavailable: ReadOnlyPriceSource = {
    source: "raydium-price",
    async read(): Promise<SourceQuote> { throw new Error("price unavailable"); },
  };
  const paper = new PaperEngine(strategy, () => "valid", undefined, () => new Date(NOW));
  await paper.start();
  const session = new MarketPaperSession({
    sources: [source("jupiter-price", "1"), unavailable],
    paper,
    nowMs: () => NOW,
    maxDeviationBps: 100,
  });
  const result = await session.open({ symbol: "USDC", mint: MINT, detectedAt: new Date(NOW).toISOString() });
  assert.equal(result.status, "rejected");
  assert.equal(paper.snapshot().paper.positions.length, 0);
}

console.log("market-to-PaperEngine bridge tests passed");
