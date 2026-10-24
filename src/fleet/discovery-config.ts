import path from "node:path";

/**
 * Shared launch-discovery switches (PR B2). ONE process on the control plane
 * holds the streaming endpoints (they embed a provider key); tenants never
 * receive them. Fail closed: anything missing or malformed => disabled, with a
 * `reason` that NEVER echoes a value.
 *
 *   DISCOVERY_ENABLED          true/1 to run the shared discovery process
 *   ARIA_STREAM_RPC_URL        wss://...   (logsSubscribe)       - holds the key
 *   ARIA_STREAM_RPC_HTTP_URL   https://... (getTransaction)      - holds the key
 *
 * The URL values only ever live in the object returned for the discovery
 * supervisor (`DiscoveryStreamEndpoints`); `DiscoveryFlags` as seen by
 * /healthz, logs and the panel carries no URL.
 */
export interface DiscoveryStreamEndpoints {
  wssUrl: string;
  httpUrl: string;
}

export type DiscoveryFlags =
  | { enabled: false; reason: string }
  | { enabled: true; endpoints: DiscoveryStreamEndpoints };

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

function parseUrl(v: string): URL | undefined {
  try { return new URL(v); } catch { return undefined; }
}

export function parseDiscoveryFlags(env: NodeJS.ProcessEnv): DiscoveryFlags {
  const raw = env.DISCOVERY_ENABLED;
  if (blank(raw)) return { enabled: false, reason: "DISCOVERY_ENABLED is not set" };
  const v = raw!.trim().toLowerCase();
  if (v === "false" || v === "0") return { enabled: false, reason: "DISCOVERY_ENABLED is not true" };
  if (v !== "true" && v !== "1") return { enabled: false, reason: "DISCOVERY_ENABLED must be true/1/false/0" };

  const wssRaw = env.ARIA_STREAM_RPC_URL;
  const httpRaw = env.ARIA_STREAM_RPC_HTTP_URL;
  if (blank(wssRaw)) return { enabled: false, reason: "ARIA_STREAM_RPC_URL is not set" };
  if (blank(httpRaw)) return { enabled: false, reason: "ARIA_STREAM_RPC_HTTP_URL is not set" };

  const wss = parseUrl(wssRaw!.trim());
  if (!wss || (wss.protocol !== "wss:" && !(wss.protocol === "ws:" && isLoopback(wss.hostname)))) {
    return { enabled: false, reason: "ARIA_STREAM_RPC_URL must be a wss:// URL" };
  }
  const http = parseUrl(httpRaw!.trim());
  if (!http || (http.protocol !== "https:" && !(http.protocol === "http:" && isLoopback(http.hostname)))) {
    return { enabled: false, reason: "ARIA_STREAM_RPC_HTTP_URL must be an https:// URL" };
  }
  return { enabled: true, endpoints: { wssUrl: wssRaw!.trim(), httpUrl: httpRaw!.trim() } };
}

/** DISCOVERY_MAX_EVENT_AGE_MS: how long without any launch before /healthz reports `stale` (default 15 min; floor 1 min; malformed -> default). */
export const DEFAULT_EVENT_STALE_MS = 15 * 60 * 1000;
export function parseEventStaleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DISCOVERY_MAX_EVENT_AGE_MS?.trim();
  if (!raw || !/^\d{1,9}$/.test(raw)) return DEFAULT_EVENT_STALE_MS;
  const n = Number(raw);
  return n >= 60_000 ? n : DEFAULT_EVENT_STALE_MS;
}

/** Where the shared discovery process keeps its files, derived from the existing volume layout (tenants live in `<volume>/tenants`). */
export interface DiscoveryPaths {
  /** NDJSON feed tenants tail: `<volume>/discovery/launches.ndjson`. */
  feedPath: string;
  /** The discovery child's own ARIA_RUNTIME_DIR: `<volume>/discovery/runtime`. */
  runtimeDir: string;
  /** Child stdout/stderr (redacted): `<logsRoot>/discovery.log`. */
  logPath: string;
}

export function discoveryPaths(tenantsRoot: string, logsRoot: string): DiscoveryPaths {
  const volume = path.dirname(path.resolve(tenantsRoot));
  return {
    feedPath: path.join(volume, "discovery", "launches.ndjson"),
    runtimeDir: path.join(volume, "discovery", "runtime"),
    logPath: path.join(path.resolve(logsRoot), "discovery.log"),
  };
}
