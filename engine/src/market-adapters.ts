import type { MarketObservation } from "./market.js";

export interface ReadOnlyMarketAdapter {
  readonly source: MarketObservation["source"];
  read(): Promise<MarketObservation[]>;
}

function keyOf(observation: Pick<MarketObservation, "mint" | "source">): string {
  return `${observation.source}:${observation.mint}`;
}

export class ObservationDeduplicator {
  private readonly latest = new Map<string, number>();

  accept(observation: MarketObservation): boolean {
    const key = keyOf(observation);
    const previous = this.latest.get(key);
    if (previous !== undefined && observation.slot <= previous) return false;
    this.latest.set(key, observation.slot);
    return true;
  }
}

export class MarketObservationStream {
  private readonly queue: MarketObservation[] = [];
  private readonly deduplicator = new ObservationDeduplicator();

  constructor(private readonly maxQueueSize = 256) {
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1) throw new Error("market queue size invalid");
  }

  push(observation: MarketObservation): boolean {
    if (observation.freshness !== "fresh" || !this.deduplicator.accept(observation)) return false;
    if (this.queue.length >= this.maxQueueSize) this.queue.shift();
    this.queue.push(observation);
    return true;
  }

  drain(): MarketObservation[] {
    return this.queue.splice(0, this.queue.length);
  }
}
