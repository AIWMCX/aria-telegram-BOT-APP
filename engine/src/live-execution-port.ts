/**
 * REAL-2 PR-1: a deliberately non-executing boundary around a local Gateway.
 * Wallet, quote, transaction, signing, and send APIs are intentionally absent.
 */
export interface GatewayReadinessProbe {
  readiness(endpoint: URL): Promise<{ reachable: boolean; upstream: string; version?: string }>;
}

export type LiveExecutionHealth =
  | { status: "healthy"; upstream: "hummingbot-gateway"; version?: string }
  | { status: "unavailable"; upstream: "hummingbot-gateway"; reason: string };

export interface LiveExecutionPort {
  health(): Promise<LiveExecutionHealth>;
}

function localGatewayUrl(value: string): URL {
  const endpoint = new URL(value);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" || !loopback) throw new Error("Gateway endpoint must use HTTPS loopback");
  return endpoint;
}

export class HummingbotGatewayExecutionAdapter implements LiveExecutionPort {
  private readonly endpoint: URL;

  constructor(endpoint: string, private readonly probe: GatewayReadinessProbe) {
    this.endpoint = localGatewayUrl(endpoint);
  }

  async health(): Promise<LiveExecutionHealth> {
    try {
      const result = await this.probe.readiness(this.endpoint);
      if (!result.reachable || result.upstream !== "gateway") {
        return { status: "unavailable", upstream: "hummingbot-gateway", reason: "local Gateway readiness check failed" };
      }
      return { status: "healthy", upstream: "hummingbot-gateway", version: result.version };
    } catch {
      return { status: "unavailable", upstream: "hummingbot-gateway", reason: "local Gateway unreachable" };
    }
  }
}
