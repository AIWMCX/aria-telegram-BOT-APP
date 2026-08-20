import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeObservation, isFreshObservation } from "./market.js";

const mint = "So11111111111111111111111111111111111111112";

test("normalizes a valid observation and computes latency", () => {
  const observation = normalizeObservation({
    mint,
    priceLamports: "1250000",
    slot: 42,
    observedAtMs: 1_000,
    receivedAtMs: 1_120,
    source: "solana-rpc",
  }, 1_120);
  assert.equal(observation.mint, mint);
  assert.equal(observation.priceLamports, "1250000");
  assert.equal(observation.sourceLatencyMs, 120);
  assert.equal(observation.freshness, "fresh");
  assert.equal(observation.confidence, "primary");
});

test("rejects malformed and future observations", () => {
  assert.throws(() => normalizeObservation({ mint, priceLamports: "-1", slot: 1, observedAtMs: 1_000, receivedAtMs: 1_100, source: "solana-rpc" }, 1_100));
  assert.throws(() => normalizeObservation({ mint, priceLamports: "1", slot: -1, observedAtMs: 1_000, receivedAtMs: 1_100, source: "solana-rpc" }, 1_100));
  assert.throws(() => normalizeObservation({ mint, priceLamports: "1", slot: 1, observedAtMs: 2_000, receivedAtMs: 2_100, source: "solana-rpc" }, 1_100));
});

test("marks old observations stale", () => {
  const observation = normalizeObservation({ mint, priceLamports: "1", slot: 1, observedAtMs: 1_000, receivedAtMs: 1_000, source: "price-feed" }, 1_000);
  assert.equal(isFreshObservation(observation, 6_001, 5_000), false);
});
