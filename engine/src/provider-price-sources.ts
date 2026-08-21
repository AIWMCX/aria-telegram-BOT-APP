import type { AuthorizedQuoteSource, ReadOnlyPriceSource, SourceQuote } from "./canonical-quote.js";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const JUPITER_PRICE_API_URL = "https://lite-api.jup.ag/price/v3";
export const RAYDIUM_PRICE_API_URL = "https://api-v3.raydium.io/mint/price";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export type PriceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PriceSourceOptions {
  fetchImpl?: PriceFetch;
  nowMs?: () => number;
  /** Confirmed Solana slot captured by the caller for provenance. Zero means unavailable, never fabricated. */
  slot?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

function assertMint(mint: string): void {
  if (!MINT_RE.test(mint)) throw new Error("market mint invalid");
}

function assertSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("market slot invalid");
}

function assertHttpsBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("price source URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function normalizeDecimalString(value: string): string {
  if (!DECIMAL_RE.test(value)) throw new Error("price unavailable: malformed decimal");
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const normalized = normalizedFraction.length > 0 ? `${whole}.${normalizedFraction}` : whole!;
  if (normalized === "0") throw new Error("price unavailable: non-positive price");
  return normalized;
}

/**
 * Jupiter v3 currently returns usdPrice as a JSON number. Convert that provider
 * representation into a non-scientific decimal string immediately; all
 * canonical reconciliation/accounting after this boundary is bigint-only.
 */
function jupiterNumberToDecimal(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("price unavailable: Jupiter price missing or invalid");
  }
  const direct = String(value);
  if (!/[eE]/.test(direct)) return normalizeDecimalString(direct);
  const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return normalizeDecimalString(fixed);
}

async function getJson(fetchImpl: PriceFetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`price unavailable: HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("price unavailable: source timeout");
    if (error instanceof Error && /price unavailable/i.test(error.message)) throw error;
    throw new Error("price unavailable: source request failed");
  } finally {
    clearTimeout(timer);
  }
}

abstract class BaseReadOnlyPriceSource implements ReadOnlyPriceSource {
  abstract readonly source: AuthorizedQuoteSource;
  protected readonly fetchImpl: PriceFetch;
  protected readonly nowMs: () => number;
  protected readonly slot: number;
  protected readonly timeoutMs: number;
  protected readonly baseUrl: string;

  constructor(options: PriceSourceOptions, defaultBaseUrl: string) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.slot = options.slot ?? 0;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error("price source timeout invalid");
    assertSlot(this.slot);
    this.baseUrl = assertHttpsBaseUrl(options.baseUrl ?? defaultBaseUrl);
  }

  protected finish(mint: string, usdPrice: string, solUsdPrice: string, startedAtMs: number): SourceQuote {
    const receivedAtMs = this.nowMs();
    const sourceLatencyMs = receivedAtMs - startedAtMs;
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0 || !Number.isSafeInteger(sourceLatencyMs) || sourceLatencyMs < 0) {
      throw new Error("price unavailable: source clock invalid");
    }
    return {
      mint,
      usdPrice: normalizeDecimalString(usdPrice),
      solUsdPrice: normalizeDecimalString(solUsdPrice),
      source: this.source,
      receivedAtMs,
      sourceLatencyMs,
      observedAtSlot: this.slot,
    };
  }
}

export class JupiterReadOnlyPriceSource extends BaseReadOnlyPriceSource {
  readonly source = "jupiter-price" as const;
  constructor(options: PriceSourceOptions = {}) { super(options, JUPITER_PRICE_API_URL); }

  async read(mint: string): Promise<SourceQuote> {
    assertMint(mint);
    const startedAtMs = this.nowMs();
    const ids = [mint, WRAPPED_SOL_MINT].map(encodeURIComponent).join(",");
    const body = await getJson(this.fetchImpl, `${this.baseUrl}?ids=${ids}`, this.timeoutMs);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("price unavailable: Jupiter response invalid");
    const entries = body as Record<string, unknown>;
    const token = entries[mint] as { usdPrice?: unknown } | undefined;
    const sol = entries[WRAPPED_SOL_MINT] as { usdPrice?: unknown } | undefined;
    if (!token || !sol) throw new Error("price unavailable: Jupiter mint not found");
    return this.finish(mint, jupiterNumberToDecimal(token.usdPrice), jupiterNumberToDecimal(sol.usdPrice), startedAtMs);
  }
}

export class RaydiumReadOnlyPriceSource extends BaseReadOnlyPriceSource {
  readonly source = "raydium-price" as const;
  constructor(options: PriceSourceOptions = {}) { super(options, RAYDIUM_PRICE_API_URL); }

  async read(mint: string): Promise<SourceQuote> {
    assertMint(mint);
    const startedAtMs = this.nowMs();
    const mints = [mint, WRAPPED_SOL_MINT].map(encodeURIComponent).join(",");
    const body = await getJson(this.fetchImpl, `${this.baseUrl}?mints=${mints}`, this.timeoutMs);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("price unavailable: Raydium response invalid");
    const payload = body as { success?: unknown; data?: unknown };
    if (payload.success !== true || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
      throw new Error("price unavailable: Raydium response invalid");
    }
    const data = payload.data as Record<string, unknown>;
    const token = data[mint];
    const sol = data[WRAPPED_SOL_MINT];
    if (typeof token !== "string" || typeof sol !== "string") throw new Error("price unavailable: Raydium mint not found");
    return this.finish(mint, token, sol, startedAtMs);
  }
}
