import assert from "node:assert/strict";
import {
  JupiterReadOnlyPriceSource,
  RaydiumReadOnlyPriceSource,
  WRAPPED_SOL_MINT,
} from "./provider-price-sources.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6ZDLuai77F1pPB263";
const NOW = 1_000_000;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

{
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    return response({
      [MINT]: { usdPrice: 0.00001234 },
      [WRAPPED_SOL_MINT]: { usdPrice: 123.45 },
    });
  };
  const source = new JupiterReadOnlyPriceSource({ fetchImpl, nowMs: () => NOW, slot: 123 });
  const quote = await source.read(MINT);
  assert.equal(source.source, "jupiter-price");
  assert.equal(quote.mint, MINT);
  assert.equal(quote.usdPrice, "0.00001234");
  assert.equal(quote.solUsdPrice, "123.45");
  assert.equal(quote.observedAtSlot, 123);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /^https:\/\/lite-api\.jup\.ag\/price\/v3\?ids=/);
  assert.ok(calls[0]!.url.includes(encodeURIComponent(MINT)));
  assert.ok(calls[0]!.url.includes(encodeURIComponent(WRAPPED_SOL_MINT)));
}

{
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    return response({ success: true, data: { [MINT]: "0.00001235", [WRAPPED_SOL_MINT]: "123.40" } });
  };
  const source = new RaydiumReadOnlyPriceSource({ fetchImpl, nowMs: () => NOW, slot: 124 });
  const quote = await source.read(MINT);
  assert.equal(source.source, "raydium-price");
  assert.equal(quote.usdPrice, "0.00001235");
  assert.equal(quote.solUsdPrice, "123.40");
  assert.equal(quote.observedAtSlot, 124);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /^https:\/\/api-v3\.raydium\.io\/mint\/price\?mints=/);
}

for (const Source of [JupiterReadOnlyPriceSource, RaydiumReadOnlyPriceSource]) {
  const source = new Source({
    fetchImpl: async () => response(Source === JupiterReadOnlyPriceSource ? {} : { success: true, data: {} }),
    nowMs: () => NOW,
    slot: 1,
  });
  await assert.rejects(() => source.read(MINT), /price unavailable/i);
}

console.log("read-only provider price source tests passed");
