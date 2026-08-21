import { randomUUID } from "node:crypto";
import { EngineCommand, EngineState, PaperEvent, StrategyConfig, type PaperPosition } from "./contracts.js";
import { rejectOpportunity, type Opportunity } from "./strategy.js";
import { SafetyLatch, type StopReason } from "./safety.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const PAPER_TOKEN_SCALE = 1_000_000_000n;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
export type LicenseCheck = () => "valid" | "expired" | "invalid";
export type CommandResult = { accepted: boolean; reason?: string };

export class PaperEngine {
  private status: EngineState["status"] = "stopped";
  private positions: PaperPosition[] = [];
  private pnlLamports = 0n;
  private readonly latch: SafetyLatch;
  constructor(private strategy: StrategyConfig, private readonly license: LicenseCheck, latch = new SafetyLatch(), private readonly now = () => new Date()) { this.latch = latch; }
  safety(): SafetyLatch { return this.latch; }
  async start(): Promise<void> {
    if (this.latch.isTripped()) throw new Error("safety stop is latched");
    if (this.license() !== "valid") { this.latch.trip("license_expired"); this.status = "stopped"; throw new Error("license is not valid"); }
    this.status = "paper_running";
  }
  async stop(reason: StopReason): Promise<void> { this.latch.trip(reason); this.status = "stopping"; this.status = "stopped"; }
  async applyCommand(command: EngineCommand): Promise<CommandResult> {
    if (command.type === "stop") { await this.stop("user_stop"); return { accepted: true }; }
    if (new Date(command.expiresAt).getTime() <= this.now().getTime()) return { accepted: false, reason: "command expired" };
    if (command.type === "start_paper") { try { await this.start(); return { accepted: true }; } catch (error) { return { accepted: false, reason: error instanceof Error ? error.message : "start rejected" }; } }
    if (command.type === "update_strategy") { if (this.status !== "stopped" && this.status !== "paper_running") return { accepted: false, reason: "engine not ready" }; this.strategy = StrategyConfig.parse(command.payload); return { accepted: true }; }
    return { accepted: false, reason: "command invalid" };
  }
  tick(opportunity: Opportunity): PaperEvent[] {
    if (this.status !== "paper_running" || this.latch.isTripped()) return [rejectOpportunity(opportunity, "paper engine stopped")];
    if (this.positions.length >= this.strategy.maxPositions) return [rejectOpportunity(opportunity, "position limit reached")];
    const entryLamports = BigInt(Math.round(this.strategy.buyAmountSol * Number(LAMPORTS_PER_SOL)));

    let quantity = "1";
    let entryPriceLamportsPerWholeToken: string | undefined;
    if (opportunity.quoteLamportsPerWholeToken !== undefined) {
      if (!POSITIVE_INTEGER_RE.test(opportunity.quoteLamportsPerWholeToken)) return [rejectOpportunity(opportunity, "canonical quote invalid")];
      const price = BigInt(opportunity.quoteLamportsPerWholeToken);
      const quantityRaw = (entryLamports * PAPER_TOKEN_SCALE) / price;
      if (quantityRaw <= 0n) return [rejectOpportunity(opportunity, "canonical quote produces zero paper quantity")];
      quantity = quantityRaw.toString();
      entryPriceLamportsPerWholeToken = price.toString();
    }

    const position: PaperPosition = {
      id: randomUUID(),
      symbol: opportunity.symbol,
      mint: opportunity.mint,
      entryLamports: entryLamports.toString(),
      ...(entryPriceLamportsPerWholeToken ? { entryPriceLamportsPerWholeToken } : {}),
      quantity,
      pnlLamports: "0",
      openedAt: this.now().toISOString(),
    };
    this.positions = [...this.positions, position];
    const quoteAudit = entryPriceLamportsPerWholeToken ? ` @ ${entryPriceLamportsPerWholeToken} lamports/token` : "";
    return [{ id: randomUUID(), kind: "paper_filled", occurredAt: this.now().toISOString(), message: `PAPER fill ${opportunity.symbol}${quoteAudit}; NO REAL ORDERS`, symbol: opportunity.symbol, mint: opportunity.mint, paperOnly: true }];
  }
  snapshot(): Pick<EngineState, "status" | "licenseStatus" | "strategy" | "paper"> {
    return { status: this.status, licenseStatus: this.license(), strategy: this.strategy, paper: { positions: this.positions, pnlLamports: this.pnlLamports.toString() } };
  }
}
