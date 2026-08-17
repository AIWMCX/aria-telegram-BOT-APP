import { Network } from "./contracts.js";

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GENESIS_BY_NETWORK: Record<Exclude<Network, "unknown">, Set<string>> = {
  "solana-devnet": new Set(["EtWTRABZaYq6iMfeYKouRu166cLkZx3xw3V5hT7s2p6V"]),
  "solana-mainnet": new Set(["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]),
};

interface JsonRpcResponse<T> { result?: T; error?: { code: number; message: string }; }
export interface RpcTransport { (url: string, init: RequestInit): Promise<Response>; }

export class SolanaRpc {
  constructor(private readonly url: string, private readonly configuredNetwork: Exclude<Network, "unknown">, private readonly transport: RpcTransport = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("RPC URL must use HTTPS");
  }

  private async call<T>(method: string, params: unknown[], timeoutMs = 5_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.transport(this.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal,
      });
      if (!response.ok) throw new Error("RPC HTTP failure");
      const body = await response.json() as JsonRpcResponse<T>;
      if (body.error || body.result === undefined) throw new Error("RPC request failed");
      return body.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("RPC timeout");
      throw new Error("RPC unavailable");
    } finally { clearTimeout(timer); }
  }

  async readIdentity(): Promise<{ network: Exclude<Network, "unknown">; slot: bigint }> {
    const genesisHash = await this.call<string>("getGenesisHash", []);
    if (!GENESIS_BY_NETWORK[this.configuredNetwork].has(genesisHash)) throw new Error("RPC network mismatch");
    const slot = await this.call<number>("getSlot", [{ commitment: "confirmed" }]);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("RPC slot invalid");
    return { network: this.configuredNetwork, slot: BigInt(slot) };
  }

  async readPublicBalance(address: string): Promise<{ address: string; lamports: bigint; slot: bigint }> {
    if (!ADDRESS_RE.test(address)) throw new Error("public wallet address invalid");
    const result = await this.call<{ context: { slot: number }; value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    if (!Number.isSafeInteger(result.value) || result.value < 0 || !Number.isSafeInteger(result.context.slot) || result.context.slot < 0) throw new Error("RPC balance invalid");
    return { address, lamports: BigInt(result.value), slot: BigInt(result.context.slot) };
  }
}
