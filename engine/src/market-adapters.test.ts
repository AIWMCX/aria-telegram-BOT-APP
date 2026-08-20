import assert from "node:assert/strict";
import { test } from "node:test";
import { ObservationDeduplicator, MarketObservationStream } from "./market-adapters.js";
import type { MarketObservation } from "./market.js";

const base: MarketObservation = { mint: "So11111111111111111111111111111111111111112", priceLamports: "1", slot: 10, observedAtMs: 1_000, receivedAtMs: 1_000, source: "solana-rpc", sourceLatencyMs: 0, freshness: "fresh", confidence: "primary" };

test("deduplicator accepts newer slots and rejects duplicates or regressions", () => {
  const dedup = new ObservationDeduplicator();
  assert.equal(dedup.accept(base), true);
  assert.equal(dedup.accept(base), false);
  assert.equal(dedup.accept({ ...base, slot: 9 }), false);
  assert.equal(dedup.accept({ ...base, slot: 11 }), true);
});

test("stream rejects stale observations and preserves accepted order", () => {
  const stream = new MarketObservationStream(5_000);
  assert.equal(stream.push({ ...base, freshness: "stale" }), false);
  assert.equal(stream.push(base), true);
  assert.deepEqual(stream.drain().map((item) => item.slot), [10]);
  assert.deepEqual(stream.drain(), []);
});
