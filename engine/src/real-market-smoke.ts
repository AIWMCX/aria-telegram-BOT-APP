import { reconcileCanonicalQuote } from "./canonical-quote.js";
import { JupiterReadOnlyPriceSource, RaydiumReadOnlyPriceSource } from "./provider-price-sources.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_DEVIATION_BPS = 150;
const MAX_AGE_MS = 15_000;

/**
 * Release smoke only: performs read-only HTTPS GETs against the two authorized
 * market providers and runs the exact production canonical agreement gate.
 * It does not create a wallet, build/sign/simulate/broadcast a transaction,
 * call swap endpoints, or mutate PaperEngine state.
 */
async function main(): Promise<void> {
  const nowMs = Date.now;
  const sources = [
    new JupiterReadOnlyPriceSource({ nowMs, timeoutMs: 8_000 }),
    new RaydiumReadOnlyPriceSource({ nowMs, timeoutMs: 8_000 }),
  ] as const;

  const settled = await Promise.allSettled(sources.map((source) => source.read(USDC_MINT)));
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [`${sources[index]!.source}: ${result.reason instanceof Error ? result.reason.message : "request failed"}`]
    : []);
  if (failures.length > 0) throw new Error(`REAL-1 read-only market smoke failed: ${failures.join("; ")}`);

  const observations = settled.map((result) => {
    if (result.status !== "fulfilled") throw new Error("unreachable provider result");
    return result.value;
  });
  const reconciled = reconcileCanonicalQuote(observations, MAX_DEVIATION_BPS, Date.now(), {
    purpose: "entry",
    maxAgeMs: MAX_AGE_MS,
  });
  if (reconciled.status !== "accepted") {
    throw new Error(`REAL-1 agreement gate rejected live providers: ${reconciled.reason}: ${reconciled.detail}`);
  }
  if (reconciled.quote.confidence !== "primary" || reconciled.quote.sourceCount !== 2) {
    throw new Error("REAL-1 live entry smoke requires two-source primary confidence");
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "paper-read-only",
    mint: reconciled.quote.mint,
    lamportsPerWholeToken: reconciled.quote.lamportsPerWholeToken.toString(),
    confidence: reconciled.quote.confidence,
    sources: reconciled.quote.sources,
    sourceCount: reconciled.quote.sourceCount,
    maxDeviationBps: reconciled.quote.maxDeviationBps,
    observedAtMs: reconciled.quote.observedAtMs,
  }));
}

await main();
