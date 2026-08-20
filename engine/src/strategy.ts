import { randomUUID } from "node:crypto";
import { StrategyConfig, type PaperEvent } from "./contracts.js";
import type { LicenseLimits } from "./license.js";

export interface Opportunity { symbol: string; mint: string; detectedAt: string; }
export function validateStrategy(input: unknown, limits: LicenseLimits): StrategyConfig {
  const strategy = StrategyConfig.parse(input);
  if (strategy.buyAmountSol > limits.maxBuySol || strategy.maxPositions > limits.maxPositions || strategy.buyAmountSol * strategy.maxPositions > limits.maxTotalSol) throw new Error("strategy exceeds licence limits");
  return strategy;
}

export function rejectOpportunity(opportunity: Opportunity, reason: string): PaperEvent {
  return { id: randomUUID(), kind: "rejected", occurredAt: new Date().toISOString(), message: `${opportunity.symbol}: ${reason}`, symbol: opportunity.symbol, mint: opportunity.mint, paperOnly: true };
}
