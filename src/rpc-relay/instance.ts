import { CONFIG } from "../config.js";
import { logger } from "../logger.js";
import { newTenantToken, parseRelayConfig, RpcRelay, type RelayConfig } from "./relay.js";
import { getOrCreateTenantToken, reconcileTenantRpcSync, relayUrl } from "../fleet/tenant-rpc-seed.js";

/**
 * The ONE private RPC relay for this process (PR F1). Off unless
 * RPC_RELAY_ENABLED=true and ARIA_STREAM_RPC_HTTP_URL is a valid https URL.
 * The upstream URL stays inside the RpcRelay instance; nothing exported here carries it.
 */
const cfg: RelayConfig = parseRelayConfig(process.env, CONFIG.PORT);
const relay: RpcRelay | undefined = cfg.enabled ? new RpcRelay({ upstreamUrl: cfg.upstreamUrl, limits: cfg.limits }) : undefined;
let boundPort: number | undefined;

export async function startRpcRelay(): Promise<void> {
  if (!relay || !cfg.enabled) {
    // Explicitly asked for but not configurable (missing/invalid upstream URL, bad limits) => WARN: tenants silently stay on the public RPC.
    const asked = /^(true|1)$/i.test(process.env.RPC_RELAY_ENABLED?.trim() ?? "");
    const reason = cfg.enabled ? "" : cfg.reason;
    if (asked) logger.warn({ reason }, "rpc relay was requested but is NOT usable; tenants keep the public RPC");
    else logger.info({ reason }, "rpc relay is DISABLED");
    return;
  }
  try {
    boundPort = await relay.listen(cfg.port);
    logger.info({ port: boundPort, host: "127.0.0.1" }, "rpc relay listening (loopback only)");
  } catch (err) {
    boundPort = undefined;
    logger.warn({ errName: (err as Error)?.name }, "rpc relay failed to start - tenants keep their existing rpc.url (public RPC)");
  }
}
export async function stopRpcRelay(): Promise<void> { await relay?.close(); }

/** True only when the relay is configured AND actually listening. */
export function rpcRelayUsable(): boolean { return relay !== undefined && boundPort !== undefined; }

/** /healthz block: counts only, never a URL, token or id. */
export function rpcRelayHealth(): { enabled: boolean; usable: boolean; requests: number; rejectedMethod: number; rateLimited: number; upstreamErrors: number } {
  const c = relay?.counts() ?? { requests: 0, rejectedMethod: 0, rateLimited: 0, upstreamErrors: 0 };
  return { enabled: cfg.enabled, usable: rpcRelayUsable(), ...c };
}

/** Revokes the tenant's relay token (tenant stopped/removed). Idempotent. */
export function unregisterTenantRpc(clientId: string): void { relay?.unregisterClient(clientId); }

/** Pre-spawn step for a tenant: point rpc.url at the relay (wanted) or revert what we seeded. Never throws. */
export function prepareTenantRpc(clientId: string, runtimeDir: string, wanted: boolean): void {
  try {
    if (wanted && relay && boundPort !== undefined) {
      const token = getOrCreateTenantToken(runtimeDir, newTenantToken);
      if (!token) { logger.warn({}, "rpc relay: could not persist tenant token; rpc.url left as is"); return; }
      relay.registerToken(clientId, token);
      const result = reconcileTenantRpcSync({ runtimeDir, enabled: true, relayUrl: relayUrl(boundPort, token) });
      if (result === "enabled") logger.info({ result }, "tenant rpc.url pointed at private relay");
    } else {
      const result = reconcileTenantRpcSync({ runtimeDir, enabled: false });
      if (result === "disabled") logger.info({ result }, "tenant rpc.url reverted from private relay");
    }
  } catch (err) {
    logger.warn({ errName: (err as Error)?.name }, "tenant rpc relay reconcile failed; starting with the existing config");
  }
}
