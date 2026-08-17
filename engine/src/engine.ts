import type { EngineState, EngineCommand } from "./contracts.js";
import type { LicenseCheck } from "./paper.js";
import { PaperEngine } from "./paper.js";
import { SolanaRpc } from "./rpc.js";
import { SafetyLatch } from "./safety.js";
import type { Opportunity } from "./strategy.js";
import type { StrategyConfig } from "./contracts.js";

export interface EngineOptions { rpc: SolanaRpc; publicAddress: string; strategy: StrategyConfig; license: LicenseCheck; }

export class Engine {
  private readonly paper: PaperEngine;
  private network: EngineState["network"] = "unknown";
  private publicAddress: string | null = null;
  private balanceLamports: string | null = null;
  constructor(private readonly options: EngineOptions) { this.paper = new PaperEngine(options.strategy, options.license, new SafetyLatch()); }
  async start(): Promise<void> {
    const identity = await this.options.rpc.readIdentity();
    const balance = await this.options.rpc.readPublicBalance(this.options.publicAddress);
    this.network = identity.network; this.publicAddress = balance.address; this.balanceLamports = balance.lamports.toString();
    await this.paper.start();
  }
  async stop(): Promise<void> { await this.paper.stop("user_stop"); }
  async applyCommand(command: EngineCommand) { return this.paper.applyCommand(command); }
  tick(opportunity: Opportunity) { return this.paper.tick(opportunity); }
  snapshot(): EngineState {
    const paper = this.paper.snapshot();
    return { status: paper.status, network: this.network, publicAddress: this.publicAddress, balanceLamports: this.balanceLamports, licenseStatus: paper.licenseStatus, strategy: paper.strategy, lastHeartbeatAt: new Date().toISOString(), paper: paper.paper };
  }
}
