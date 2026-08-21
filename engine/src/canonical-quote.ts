export type AuthorizedQuoteSource = "jupiter-price" | "raydium-price";
export type QuotePurpose = "entry" | "mark";

export interface SourceQuote {
  mint: string;
  /** A non-scientific, positive USD decimal represented without IEEE-754 conversion. */
  usdPrice: string;
  /** A non-scientific, positive SOL/USD decimal represented without IEEE-754 conversion. */
  solUsdPrice: string;
  source: AuthorizedQuoteSource;
  receivedAtMs: number;
  sourceLatencyMs: number;
  observedAtSlot: number;
}

export interface ReadOnlyPriceSource {
  readonly source: AuthorizedQuoteSource;
  read(mint: string): Promise<SourceQuote>;
}

export interface QuoteProvenance {
  source: AuthorizedQuoteSource;
  sourceLatencyMs: number;
  receivedAtMs: number;
}

export interface CanonicalQuote {
  mint: string;
  /** Exact paper-accounting price. Decimal input is rounded down once here. */
  lamportsPerWholeToken: bigint;
  observedAtMs: number;
  receivedAtMs: number;
  observedAtSlot: number;
  confidence: "primary" | "secondary";
  sources: readonly AuthorizedQuoteSource[];
  sourceCount: number;
  maxDeviationBps: number;
  provenance: readonly QuoteProvenance[];
}

export type CanonicalQuoteResult =
  | { status: "accepted"; quote: CanonicalQuote }
  | { status: "rejected"; reason: "no-authorized-sources" | "insufficient-sources" | "stale-source" | "invalid-price" | "mint-mismatch" | "disagreement-exceeds-threshold"; detail: string };

export interface ReconcileOptions {
  purpose?: QuotePurpose;
  maxAgeMs?: number;
}

const SOURCE_ORDER: readonly AuthorizedQuoteSource[] = ["jupiter-price", "raydium-price"];
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const LAMPORTS_PER_SOL = 1_000_000_000n;

function isAuthorizedSource(value: unknown): value is AuthorizedQuoteSource {
  return typeof value === "string" && SOURCE_ORDER.includes(value as AuthorizedQuoteSource);
}

function decimalRational(value: string): { numerator: bigint; denominator: bigint } | null {
  if (!DECIMAL_RE.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator <= 0n) return null;
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/** Converts token USD / SOL USD using integer rational arithmetic, rounding down once to lamports. */
function quoteLamports(quote: SourceQuote): bigint | null {
  const tokenUsd = decimalRational(quote.usdPrice);
  const solUsd = decimalRational(quote.solUsdPrice);
  if (!tokenUsd || !solUsd) return null;
  return (tokenUsd.numerator * solUsd.denominator * LAMPORTS_PER_SOL) /
    (tokenUsd.denominator * solUsd.numerator);
}

function sourceIsFresh(quote: SourceQuote, nowMs: number, maxAgeMs: number): boolean {
  if (!Number.isSafeInteger(quote.receivedAtMs) || !Number.isSafeInteger(quote.sourceLatencyMs) || !Number.isSafeInteger(quote.observedAtSlot)) return false;
  if (quote.receivedAtMs < 0 || quote.sourceLatencyMs < 0 || quote.observedAtSlot < 0 || quote.sourceLatencyMs > quote.receivedAtMs) return false;
  const age = nowMs - quote.receivedAtMs;
  return age >= 0 && age <= maxAgeMs;
}

function deviationBps(prices: readonly bigint[]): number {
  const min = prices.reduce((a, b) => a < b ? a : b);
  const max = prices.reduce((a, b) => a > b ? a : b);
  if (min === 0n) return max === 0n ? 0 : Number.POSITIVE_INFINITY;
  const numerator = (max - min) * 10_000n;
  return Number((numerator + min - 1n) / min);
}

export function reconcileCanonicalQuote(observations: readonly SourceQuote[], maxDeviationBps: number, nowMs: number, options: ReconcileOptions = {}): CanonicalQuoteResult {
  const purpose = options.purpose ?? "entry";
  const maxAgeMs = options.maxAgeMs ?? 5_000;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !Number.isSafeInteger(maxDeviationBps) || maxDeviationBps < 0) {
    return { status: "rejected", reason: "invalid-price", detail: "reconciliation configuration invalid" };
  }
  if (observations.length === 0 || observations.some((quote) => !isAuthorizedSource(quote.source))) {
    return { status: "rejected", reason: "no-authorized-sources", detail: "only Jupiter and Raydium read-only prices are authorized" };
  }
  if (new Set(observations.map((quote) => quote.source)).size !== observations.length) {
    return { status: "rejected", reason: "insufficient-sources", detail: "duplicate source cannot satisfy agreement" };
  }
  const requiredSources = purpose === "entry" ? 2 : 1;
  if (observations.length < requiredSources) {
    return { status: "rejected", reason: "insufficient-sources", detail: `${purpose} requires ${requiredSources} authorized source${requiredSources === 1 ? "" : "s"}` };
  }
  if (observations.some((quote) => !MINT_RE.test(quote.mint))) {
    return { status: "rejected", reason: "mint-mismatch", detail: "mint format invalid" };
  }
  if (new Set(observations.map((quote) => quote.mint)).size !== 1) {
    return { status: "rejected", reason: "mint-mismatch", detail: "authorized sources returned different mints" };
  }
  if (observations.some((quote) => !sourceIsFresh(quote, nowMs, maxAgeMs))) {
    return { status: "rejected", reason: "stale-source", detail: "all authorized sources must be fresh" };
  }
  const priced = observations.map((quote) => ({ quote, lamports: quoteLamports(quote) }));
  if (priced.some(({ lamports }) => lamports === null)) {
    return { status: "rejected", reason: "invalid-price", detail: "source returned a non-positive or malformed decimal price" };
  }
  const prices = priced.map(({ lamports }) => lamports!);
  const actualDeviationBps = deviationBps(prices);
  if (!Number.isFinite(actualDeviationBps) || actualDeviationBps > maxDeviationBps) {
    return { status: "rejected", reason: "disagreement-exceeds-threshold", detail: `${actualDeviationBps} bps exceeds ${maxDeviationBps} bps` };
  }
  const ordered = [...priced].sort((a, b) => SOURCE_ORDER.indexOf(a.quote.source) - SOURCE_ORDER.indexOf(b.quote.source));
  const conservativeReceivedAtMs = Math.min(...ordered.map(({ quote }) => quote.receivedAtMs));
  const conservativeObservedAtMs = Math.min(...ordered.map(({ quote }) => quote.receivedAtMs - quote.sourceLatencyMs));
  const conservativeSlot = Math.min(...ordered.map(({ quote }) => quote.observedAtSlot));
  return {
    status: "accepted",
    quote: {
      mint: ordered[0]!.quote.mint,
      lamportsPerWholeToken: prices.reduce((sum, price) => sum + price, 0n) / BigInt(prices.length),
      observedAtMs: conservativeObservedAtMs,
      receivedAtMs: conservativeReceivedAtMs,
      observedAtSlot: conservativeSlot,
      confidence: observations.length >= 2 ? "primary" : "secondary",
      sources: ordered.map(({ quote }) => quote.source),
      sourceCount: ordered.length,
      maxDeviationBps: actualDeviationBps,
      provenance: ordered.map(({ quote }) => ({ source: quote.source, sourceLatencyMs: quote.sourceLatencyMs, receivedAtMs: quote.receivedAtMs })),
    },
  };
}
