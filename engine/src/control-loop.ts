import type { EngineCommand, SanitizedEvent } from "./contracts.js";
import { AuthenticatedClient } from "./authenticated-client.js";
import type { Engine } from "./engine.js";

export interface ControlLoopEngine { snapshot(): import("./contracts.js").EngineState; applyCommand(command: EngineCommand): Promise<{ accepted: boolean; reason?: string }>; }

export class ControlLoop {
  private stopped = false;
  constructor(private readonly client: AuthenticatedClient, private readonly engine: ControlLoopEngine, private readonly intervalMs = 2_000, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}
  stop(): void { this.stopped = true; }
  async run(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      try {
        await this.client.heartbeat({ engineVersion: "0.1.0", state: this.engine.snapshot() });
        const commands = await this.client.commands();
        for (const command of commands) {
          const result = await this.engine.applyCommand(command);
          await this.client.acknowledge(command.id, result.accepted, result.reason);
        }
        await this.sleep(this.intervalMs);
      } catch {
        await this.sleep(Math.min(this.intervalMs * 4, 10_000));
      }
    }
  }
}
