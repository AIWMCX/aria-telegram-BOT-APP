import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-tenant discovery source seeding (PR B2). A tenant gets the shared feed
 * through its OWN runtime config (`discovery: { source: "file-tail", path }`
 * - a path, never an endpoint or key), and only while DISCOVERY is enabled.
 * Turning discovery off flips a tenant that points at OUR feed back to the
 * engine's polling default; a tenant config that points anywhere else is
 * never touched.
 *
 * The edit is a direct, synchronous, ATOMIC rewrite of the tenant's
 * `config.json` (read -> change only the `discovery` key -> temp file in the
 * same directory, mode 0600 -> rename). No child process is spawned, so this
 * costs microseconds and can never delay capacity/memory admission. Because
 * the read-modify-write runs to completion inside one event-loop turn, two
 * concurrent spawnTenant() calls for the same tenant cannot interleave.
 *
 * Only a file that looks like a real engine config (schemaVersion 1 and the
 * rpc/paper/market sections) is edited. A missing or unrecognised file is
 * left alone ("deferred"): the engine creates its default config on first
 * run and the NEXT spawn seeds it. The engine remains the validator of the
 * `discovery` section when it loads the file (an invalid one makes it refuse
 * to start, which is why the written shape is exactly the engine's).
 */
export type SeedResult = "enabled" | "disabled" | "unchanged" | "deferred";

export interface TenantDiscoveryState { source: string | undefined; path: string | undefined }

function readConfig(runtimeDir: string): { file: string; cfg: Record<string, any> } | undefined {
  const file = path.join(runtimeDir, "config.json");
  if (!existsSync(file)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return undefined;
    return { file, cfg: cfg as Record<string, any> };
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

/** Does this look like a full engine config (so editing one key cannot turn it into something else)? */
function looksLikeEngineConfig(cfg: Record<string, any>): boolean {
  return cfg.schemaVersion === 1 && isObj(cfg.rpc) && isObj(cfg.paper) && isObj(cfg.market);
}

export function readTenantDiscoveryState(runtimeDir: string): TenantDiscoveryState {
  const c = readConfig(runtimeDir);
  const d = c?.cfg.discovery;
  return {
    source: isObj(d) && typeof d.source === "string" ? d.source : undefined,
    path: isObj(d) && typeof d.path === "string" ? d.path : undefined,
  };
}

let tmpCounter = 0;
function writeAtomic(file: string, cfg: Record<string, any>): void {
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

/** Synchronous core. Throws only on an I/O failure while writing (the caller treats that as non-fatal). */
export function reconcileTenantDiscoverySync(o: { runtimeDir: string; feedPath: string; enabled: boolean }): SeedResult {
  const c = readConfig(o.runtimeDir);
  if (!c || !looksLikeEngineConfig(c.cfg)) return "deferred";
  const cur = isObj(c.cfg.discovery) ? (c.cfg.discovery as Record<string, any>) : undefined;
  const onOurFeed = cur?.source === "file-tail" && cur?.path === o.feedPath;
  if (o.enabled && !onOurFeed) {
    c.cfg.discovery = { ...(cur ?? {}), source: "file-tail", path: o.feedPath };
    writeAtomic(c.file, c.cfg);
    return "enabled";
  }
  if (!o.enabled && onOurFeed) {
    c.cfg.discovery = { ...cur, source: "polling" }; // path kept: harmless, and validation accepts it
    writeAtomic(c.file, c.cfg);
    return "disabled";
  }
  return "unchanged";
}

export async function reconcileTenantDiscovery(o: { runtimeDir: string; feedPath: string; enabled: boolean }): Promise<SeedResult> {
  return reconcileTenantDiscoverySync(o);
}
