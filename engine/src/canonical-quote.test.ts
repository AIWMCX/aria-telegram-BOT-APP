import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCanonicalQuote, type SourceQuote } from "./canonical-quote.js";

const MINT = "So11111111111111111111111111111111111111112";
const NOW = 1_000_000;

function quote(source: SourceQuote["source"], usdPrice = "2.001", solUsdPrice = "100", receivedAtMs = NOW - 100): SourceQuote {
  return { mint: MINT, usdPrice, solUsdPrice, source, receivedAtMs, sourceLatencyMs: 20, observedAtSlot: 123 };
}

test("Jupiter and Raydium agreeing prices produce an exact primary bigint quote", () => {
  const result = reconcileCanonicalQuote([quote("jupiter-price"), quote("raydium-price", "2.0010")], 10, NOW);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.quote.lamportsPerWholeToken, 20_010_000n);
  assert.equal(result.quote.confidence, "primary");
  assert.deepEqual(result.quote.sources, ["jupiter-price", "raydium-price"]);
  assert.equal(result.quote.maxDeviationBps, 0);
});

test("price exactly at the deviation threshold is accepted and one basis point above is rejected", () => {
  const accepted = reconcileCanonicalQuote([quote("jupiter-price", "100"), quote("raydium-price", "100.1")], 10, NOW);
  assert.equal(accepted.status, "accepted");
  const rejected = reconcileCanonicalQuote([quote("jupiter-price", "100"), quote("raydium-price", "100.1001")], 10, NOW);
  assert.deepEqual(rejected, { status: "rejected", reason: "disagreement-exceeds-threshold", detail: "11 bps exceeds 10 bps" });
});

test("entry rejects one source but mark accepts one fresh authorized source as secondary", () => {
  assert.equal(reconcileCanonicalQuote([quote("jupiter-price")], 10, NOW).status, "rejected");
  const mark = reconcileCanonicalQuote([quote("raydium-price")], 10, NOW, { purpose: "mark" });
  assert.equal(mark.status, "accepted");
  if (mark.status !== "accepted") return;
  assert.equal(mark.quote.confidence, "secondary");
  assert.equal(mark.quote.sourceCount, 1);
});

test("stale, mismatched, invalid, and unauthorized observations fail closed", () => {
  assert.equal(reconcileCanonicalQuote([quote("jupiter-price", "2", "100", NOW - 6_000), quote("raydium-price", "2")], 10, NOW).status, "rejected");
  assert.equal(reconcileCanonicalQuote([quote("jupiter-price"), { ...quote("raydium-price"), mint: "11111111111111111111111111111111" }], 10, NOW).status, "rejected");
  assert.equal(reconcileCanonicalQuote([quote("jupiter-price", "0"), quote("raydium-price")], 10, NOW).status, "rejected");
  assert.equal(reconcileCanonicalQuote([{ ...quote("jupiter-price"), source: "test" as never }, quote("raydium-price")], 10, NOW).status, "rejected");
});

test("decimal conversion is deterministic and rounds sub-lamports down", () => {
  const a = reconcileCanonicalQuote([quote("jupiter-price", "0.00000000019", "1"), quote("raydium-price", "0.00000000019", "1")], 0, NOW);
  const b = reconcileCanonicalQuote([quote("jupiter-price", "0.00000000019", "1"), quote("raydium-price", "0.00000000019", "1")], 0, NOW);
  assert.equal(a.status, "accepted");
  assert.equal(b.status, "accepted");
  if (a.status !== "accepted" || b.status !== "accepted") return;
  assert.equal(a.quote.lamportsPerWholeToken, 0n);
  assert.equal(a.quote.lamportsPerWholeToken, b.quote.lamportsPerWholeToken);
});
