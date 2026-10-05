import assert from "node:assert/strict";
import { JupiterV2Client } from "../src/live/jupiter-v2-client.js";

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TAKER = "11111111111111111111111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let seenUrl = "";
let seenHeaders: HeadersInit | undefined;
const okClient = new JupiterV2Client({
  apiKey: "test-key",
  fetchImpl: (async (input, init) => {
    seenUrl = String(input);
    seenHeaders = init?.headers;
    return jsonResponse({
      transaction: "AQID",
      requestId: "req-1",
      inAmount: "1000000",
      outAmount: "123",
      router: "metis",
      mode: "manual",
      feeBps: 10,
      feeMint: MINT_A,
      lastValidBlockHeight: 123456,
    });
  }) as typeof fetch,
});

const order = await okClient.order({
  inputMint: MINT_A,
  outputMint: MINT_B,
  amountRaw: 1_000_000n,
  taker: TAKER,
  slippageBps: 100,
});
assert.equal(order.ok, true);
assert.match(seenUrl, /\/swap\/v2\/order\?/);
assert.match(seenUrl, /slippageBps=100/);
assert.equal((seenHeaders as Record<string, string>)["x-api-key"], "test-key");

const emptyTxClient = new JupiterV2Client({
  apiKey: "test-key",
  fetchImpl: (async () => jsonResponse({
    transaction: "",
    requestId: "req-2",
    outAmount: "123",
    router: "metis",
    mode: "manual",
    feeBps: 10,
    feeMint: MINT_A,
    errorCode: 3,
    errorMessage: "cannot build",
  })) as typeof fetch,
});
const empty = await emptyTxClient.order({ inputMint: MINT_A, outputMint: MINT_B, amountRaw: 1n, taker: TAKER, slippageBps: 100 });
assert.equal(empty.ok, false);
if (!empty.ok) assert.equal(empty.code, "ORDER_NOT_BUILDABLE");

const badInput = await okClient.order({ inputMint: "nope", outputMint: MINT_B, amountRaw: 1n, taker: TAKER, slippageBps: 100 });
assert.equal(badInput.ok, false);
if (!badInput.ok) assert.equal(badInput.code, "INVALID_INPUT");

const executeClient = new JupiterV2Client({
  apiKey: "test-key",
  fetchImpl: (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.requestId, "req-1");
    assert.equal(body.signedTransaction, "SIGNED");
    return jsonResponse({
      status: "Success",
      signature: "5".repeat(64),
      code: 0,
      totalInputAmount: "100",
      totalOutputAmount: "90",
      inputAmountResult: "100",
      outputAmountResult: "90",
    });
  }) as typeof fetch,
});
const executed = await executeClient.execute({ signedTransactionB64: "SIGNED", requestId: "req-1", lastValidBlockHeight: 123 });
assert.equal(executed.ok, true);

const failedClient = new JupiterV2Client({
  apiKey: "test-key",
  fetchImpl: (async () => jsonResponse({ status: "Failed", signature: "", code: -1000, error: "failed to land" })) as typeof fetch,
});
const failed = await failedClient.execute({ signedTransactionB64: "SIGNED", requestId: "req-x" });
assert.equal(failed.ok, false);
if (!failed.ok) assert.equal(failed.code, "EXECUTE_REJECTED");

const indeterminateClient = new JupiterV2Client({
  apiKey: "test-key",
  fetchImpl: (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as typeof fetch,
});
const indeterminate = await indeterminateClient.execute({ signedTransactionB64: "SIGNED", requestId: "req-x" });
assert.equal(indeterminate.ok, false);
if (!indeterminate.ok) assert.equal(indeterminate.code, "EXECUTE_INDETERMINATE");

const noKey = new JupiterV2Client({ apiKey: "" });
const noKeyResult = await noKey.order({ inputMint: MINT_A, outputMint: MINT_B, amountRaw: 1n, taker: TAKER, slippageBps: 100 });
assert.equal(noKeyResult.ok, false);
if (!noKeyResult.ok) assert.equal(noKeyResult.code, "NOT_CONFIGURED");

console.log("live-jupiter-v2-client: ok");
