import type { CanonicalQuote, CanonicalQuoteResult, ReadOnlyPriceSource, SourceQuote } from "./canonical-quote.js";
import { reconcileCanonicalQuote } from "./canonical-quote.js";
import type { PaperEvent } from "./contracts.js";
import type { PaperEngine } from "./paper.js";
import { rejectOpportunity, type Opportunity } from "./strategy.js";

export interface MarketPaperSessionOptions {
  sources: readonly ReadOnlyPriceSource[];
  paper: PaperEngine;
  nowMs?: () => number;
  maxDeviationBps: number;
  maxAgeMs?: number;
}

export type MarketPaperOpenResult =
  | { status: "accepted"; quote: CanonicalQuote; events: PaperEvent[] }
  | { status: "rejected"; reason: Extract<CanonicalQuoteResult, { status: "rejected" }>["reason"]; detail: string; events: PaperEvent[] };

/**
 * REAL-1 bridge from authorized read-only provider observations into the
 * deterministic PaperEngine. This component has no wallet, signer, swap,
 * transaction, or broadcast interface. New exposure requires the canonical
 * entry agreement gate; provider failures are observations of unavailability,
 * never permission to invent or fall back to a price.
 */
export class MarketPaperSession {
  private readonly sources: readonly ReadOnlyPriceSource[];
  private readonly paper: PaperEngine;
  private readonly nowMs: () => number;
  private readonly maxDeviationBps: number;
  private readonly maxAgeMs: number;

  constructor(options: MarketPaperSessionOptions) {
    if (options.sources.length === 0) throw new Error("market session requires at least one read-only source");
    if (!Number.isSafeInteger(options.maxDeviationBps) || options.maxDeviationBps < 0) throw new Error("market deviation limit invalid");
    this.sources = options.sources;
    this.paper = options.paper;
    this.nowMs = options.nowMs ?? Date.now;
    this.maxDeviationBps = options.maxDeviationBps;
    this.maxAgeMs = options.maxAgeMs ?? 5_000;
  }

  private async collect(mint: string): Promise<SourceQuote[]> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.read(mint)));
    const observations: SourceQuote[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") observations.push(result.value);
    }
    return observations;
  }

  async open(opportunity: Opportunity): Promise<MarketPaperOpenResult> {
    const observations = await this.collect(opportunity.mint);
    const reconciled = reconcileCanonicalQuote(observations, this.maxDeviationBps, this.nowMs(), {
      purpose: "entry",
      maxAgeMs: this.maxAgeMs,
    });
    if (reconciled.status === "rejected") {
      const event = rejectOpportunity(opportunity, `market quote rejected: ${reconciled.reason}`);
      return { status: "rejected", reason: reconciled.reason, detail: reconciled.detail, events: [event] };
    }

    const quotedOpportunity: Opportunity = {
      ...opportunity,
      quoteLamportsPerWholeToken: reconciled.quote.lamportsPerWholeToken.toString(),
    };
    const events = this.paper.tick(quotedOpportunity);
    if (events.some((event) => event.kind === "paper_filled")) {
      return { status: "accepted", quote: reconciled.quote, events };
    }
    return {
      status: "rejected",
      reason: "invalid-price",
      detail: events[0]?.message ?? "PaperEngine rejected canonical market opportunity",
      events,
    };
  }

  /**
   * Read-only mark acquisition for an already-open paper position. One fresh
   * authorized provider is sufficient by design; this does not mutate the
   * PaperEngine until a separate mark/PnL state transition consumes it.
   */
  async readMark(mint: string): Promise<CanonicalQuoteResult> {
    const observations = await this.collect(mint);
    return reconcileCanonicalQuote(observations, this.maxDeviationBps, this.nowMs(), {
      purpose: "mark",
      maxAgeMs: this.maxAgeMs,
    });
  }
}
