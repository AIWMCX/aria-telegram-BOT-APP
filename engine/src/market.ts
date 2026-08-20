import { z } from "zod";

export const MarketSource = z.enum(["solana-rpc", "stream", "price-feed", "pool"]).readonly();
export type MarketSource = z.infer<typeof MarketSource>;
export type ObservationFreshness = "fresh" | "stale";
export type ObservationConfidence = "primary" | "secondary" | "degraded";

const INPUT = z.object({
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  priceLamports: z.string().regex(/^(0|[1-9][0-9]*)$/),
  slot: z.number().int().nonnegative().safe(),
  observedAtMs: z.number().int().nonnegative().safe(),
  receivedAtMs: z.number().int().nonnegative().safe(),
  source: MarketSource,
}).strict();

export interface MarketObservation {
  mint: string;
  priceLamports: string;
  slot: number;
  observedAtMs: number;
  receivedAtMs: number;
  source: MarketSource;
  sourceLatencyMs: number;
  freshness: ObservationFreshness;
  confidence: ObservationConfidence;
}

function confidenceFor(source: MarketSource): ObservationConfidence {
  if (source === "solana-rpc") return "primary";
  if (source === "stream" || source === "price-feed") return "secondary";
  return "degraded";
}

export function isFreshObservation(observation: Pick<MarketObservation, "receivedAtMs">, nowMs: number, maxAgeMs: number): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return false;
  const age = nowMs - observation.receivedAtMs;
  return age >= 0 && age <= maxAgeMs;
}

export function normalizeObservation(input: unknown, nowMs: number, maxAgeMs = 5_000): MarketObservation {
  const value = INPUT.parse(input);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("observation clock invalid");
  if (value.receivedAtMs < value.observedAtMs) throw new Error("observation timestamps out of order");
  if (value.observedAtMs > nowMs || value.receivedAtMs > nowMs) throw new Error("observation timestamp is in the future");
  const sourceLatencyMs = value.receivedAtMs - value.observedAtMs;
  return {
    ...value,
    sourceLatencyMs,
    freshness: isFreshObservation(value, nowMs, maxAgeMs) ? "fresh" : "stale",
    confidence: confidenceFor(value.source),
  };
}
