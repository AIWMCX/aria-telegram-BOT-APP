import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-tenant RPC relay seeding (PR F1). Same mechanism as tenant-sniper-seed.ts:
 * a synchronous, ATOMIC rewrite of the tenant's `config.json` (temp file in the
 * same directory, mode 0600, rename) that sets ONLY `rpc.url` to the tenant's
 * private relay URL `http://127.0.0.1:<port>/rpc/<token>`.
 *
 * Reversal: the first enable records the previous `rpc.url` in a SIDECAR
 * `<runtimeDir>/rpc-relay-seed.json` (never inside config.json, so the engine's
 * validator never sees it). Disable restores it only if `rpc.url` STILL equals
 * what we wrote (an operator edit is left alone), then removes the sidecar.
 * A tenant without a sidecar is never touched by a disable.
 *
 * The relay URL holds the tenant token, NOT the provider key; it is fine in the
 * 0600 tenant config but is never logged by this module.
 */
export type RpcSeedResult = "enabled" | "disabled" | "unchanged" | "deferred";

export const RPC_SEED_SIDECAR = "rpc-relay-seed.json";
export const RPC_TOKEN_FILE = "rpc-relay-token";

interface Sidecar { v: 1; prevUrl: string; wroteUrl: string }

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
function readJson(file: string): unknown { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } }
function looksLikeEngineConfig(cfg: Record<string, any>): boolean {
  return cfg.schemaVersion === 1 && isObj(cfg.rpc) && isObj(cfg.paper) && isObj(cfg.market) && typeof cfg.rpc.url === "string";
}
let tmpCounter = 0;
function writeAtomicText(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}
const writeAtomic = (file: string, value: unknown): void => writeAtomicText(file, JSON.stringify(value, null, 2));

export function relayUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/rpc/${token}`;
}

/** `relayUrl` is required when enabled; ignored when disabled. */
export function reconcileTenantRpcSync(o: { runtimeDir: string; enabled: boolean; relayUrl?: string }): RpcSeedResult {
  const cfgFile = path.join(o.runtimeDir, "config.json");
  const sidecarFile = path.join(o.runtimeDir, RPC_SEED_SIDECAR);
  const rawSide = readJson(sidecarFile);
  const sidecar = isObj(rawSide) && rawSide.v === 1 && typeof rawSide.prevUrl === "string" && typeof rawSide.wroteUrl === "string" ? (rawSide as unknown as Sidecar) : undefined;
  const cfg = existsSync(cfgFile) ? readJson(cfgFile) : undefined;

  if (!o.enabled) {
    if (!sidecar) return "unchanged";
    if (isObj(cfg) && looksLikeEngineConfig(cfg)) {
      if (cfg.rpc.url === sidecar.wroteUrl) { cfg.rpc.url = sidecar.prevUrl; writeAtomic(cfgFile, cfg); }
    } else if (existsSync(cfgFile)) {
      return "deferred"; // unreadable: keep the sidecar so a later pass can still revert
    }
    try { unlinkSync(sidecarFile); } catch { /* already gone */ }
    return "disabled";
  }

  if (!o.relayUrl) return "unchanged";
  if (!isObj(cfg) || !looksLikeEngineConfig(cfg)) return "deferred";
  if (cfg.rpc.url === o.relayUrl) return "unchanged";
  if (sidecar && cfg.rpc.url !== sidecar.wroteUrl) return "unchanged"; // operator changed it since we wrote it: theirs now
  // Sidecar FIRST so a crash between the two writes still leaves the revert information.
  const record: Sidecar = { v: 1, prevUrl: sidecar ? sidecar.prevUrl : cfg.rpc.url, wroteUrl: o.relayUrl };
  writeAtomic(sidecarFile, record);
  cfg.rpc.url = o.relayUrl;
  writeAtomic(cfgFile, cfg);
  return "enabled";
}

/** Reads the tenant's persisted token or creates it (0600). Returns undefined on I/O failure. */
export function getOrCreateTenantToken(runtimeDir: string, gen: () => string): string | undefined {
  const f = path.join(runtimeDir, RPC_TOKEN_FILE);
  try {
    const t = readFileSync(f, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(t)) return t;
  } catch { /* create */ }
  try {
    const t = gen();
    writeAtomicText(f, t);
    return t;
  } catch { return undefined; }
}
