import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-tenant PAPER SNIPER config seeding (PR E). Same mechanism as
 * tenant-discovery-seed.ts: a direct, synchronous, ATOMIC rewrite of the
 * tenant's `config.json` (temp file in the same directory, mode 0600, rename).
 *
 * What it sets, and ONLY this (engine keys verified in aria-engine
 * src/paper/sniper/sniper-config.ts and runtime-config.ts @ 4fadcd3):
 *   market.kind                -> "real-discovery"  (the engine selects the sniper when this AND
 *                                                    discovery.source="file-tail" both hold)
 *   sniper.buyLamports         -> "50000000"   (0.05 SOL / trade; bigint fields are decimal strings)
 *   sniper.maxOpen             -> 3
 *   sniper.maxExposureLamports -> "300000000"  (0.3 SOL)
 *   sniper.dailyLossHaltLamports -> "150000000" (0.15 SOL, UTC day)
 *   sniper.stopLossBps         -> 3000         (-30%)
 *   sniper.maxHoldMs           -> 1800000      (30 min)
 * These equal the engine's PRD proposals, written explicitly so the confirmed
 * limits live in the tenant file instead of in an engine default that could
 * change. The BASELINE strategy keeps its own engine defaults (SL 3000 bps,
 * max hold 30 min, TP 10000 bps), which already match.
 *
 * Reversal ("disable reverts only what we set"): the first enable records, in a
 * SIDECAR file `<runtimeDir>/paper-sniper-seed.json` (never inside config.json,
 * so the engine's validator never sees it), the previous market.kind and the
 * previous value (or absence) of every sniper key we overwrite. Disable puts
 * back only values that STILL equal what we wrote (a value the operator changed
 * since is left alone), then removes the sidecar. A tenant without a sidecar is
 * never touched by a disable.
 *
 * Only a file that looks like a real engine config is edited; a missing or
 * unrecognised file is "deferred" (the engine creates its default on first run
 * and the NEXT spawn seeds it). Seeding requires the tenant to ALREADY point at
 * our shared discovery feed (the sniper reads that feed; without it the engine
 * would fall back to the polling discoverer), otherwise "no_feed".
 */
export type SniperSeedResult = "enabled" | "disabled" | "unchanged" | "deferred" | "no_feed";

/** Founder-confirmed risk limits, in the engine's own units. */
export const PAPER_SNIPER_LIMITS: Readonly<Record<string, string | number>> = Object.freeze({
  buyLamports: "50000000",
  maxOpen: 3,
  maxExposureLamports: "300000000",
  dailyLossHaltLamports: "150000000",
  stopLossBps: 3000,
  maxHoldMs: 1_800_000,
});

export const SNIPER_SEED_SIDECAR = "paper-sniper-seed.json";

interface Sidecar {
  v: 1;
  /** market.kind before we first changed it. */
  prevMarketKind: string;
  /** Previous value of each sniper key we overwrote; `null` marks "key was absent". */
  prevSniper: Record<string, unknown>;
  /** True when config.sniper did not exist at all. */
  sniperWasAbsent: boolean;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

function looksLikeEngineConfig(cfg: Record<string, any>): boolean {
  return cfg.schemaVersion === 1 && isObj(cfg.rpc) && isObj(cfg.paper) && isObj(cfg.market);
}

let tmpCounter = 0;
function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

export function readSniperSeedSidecar(runtimeDir: string): Sidecar | undefined {
  const s = readJson(path.join(runtimeDir, SNIPER_SEED_SIDECAR));
  return isObj(s) && s.v === 1 && typeof s.prevMarketKind === "string" && isObj(s.prevSniper) ? (s as unknown as Sidecar) : undefined;
}

/** Synchronous core. Throws only on an I/O failure while writing (the caller treats that as non-fatal). */
export function reconcileTenantSniperSync(o: { runtimeDir: string; feedPath: string; enabled: boolean }): SniperSeedResult {
  const cfgFile = path.join(o.runtimeDir, "config.json");
  const sidecarFile = path.join(o.runtimeDir, SNIPER_SEED_SIDECAR);
  const sidecar = readSniperSeedSidecar(o.runtimeDir);

  if (!o.enabled) {
    if (!sidecar) return "unchanged"; // we never seeded this tenant: never touch it
    const cfg = existsSync(cfgFile) ? readJson(cfgFile) : undefined;
    if (isObj(cfg) && looksLikeEngineConfig(cfg)) {
      if (cfg.market.kind === "real-discovery") cfg.market.kind = sidecar.prevMarketKind;
      if (isObj(cfg.sniper)) {
        for (const [k, written] of Object.entries(PAPER_SNIPER_LIMITS)) {
          if (cfg.sniper[k] !== written) continue; // operator changed it since: leave it
          const prev = sidecar.prevSniper[k];
          if (prev === null || prev === undefined) delete cfg.sniper[k];
          else cfg.sniper[k] = prev;
        }
        if (sidecar.sniperWasAbsent && Object.keys(cfg.sniper).length === 0) delete cfg.sniper;
      }
      writeAtomic(cfgFile, cfg);
    } else if (existsSync(cfgFile)) {
      return "deferred"; // unreadable config: keep the sidecar so a later pass can still revert
    }
    try { unlinkSync(sidecarFile); } catch { /* already gone */ }
    return "disabled";
  }

  const cfg = existsSync(cfgFile) ? readJson(cfgFile) : undefined;
  if (!isObj(cfg) || !looksLikeEngineConfig(cfg)) return "deferred";
  const d = cfg.discovery;
  if (!(isObj(d) && d.source === "file-tail" && d.path === o.feedPath)) return "no_feed";

  const sniper = isObj(cfg.sniper) ? cfg.sniper : undefined;
  const needsChange = cfg.market.kind !== "real-discovery" || Object.entries(PAPER_SNIPER_LIMITS).some(([k, v]) => sniper?.[k] !== v);
  if (!needsChange) return "unchanged"; // already exactly configured (by us earlier, or by hand): nothing to write

  // Sidecar FIRST (so a crash between the two writes still leaves the revert information).
  if (!sidecar) {
    const prevSniper: Record<string, unknown> = {};
    for (const k of Object.keys(PAPER_SNIPER_LIMITS)) prevSniper[k] = sniper && k in sniper ? sniper[k] : null;
    const record: Sidecar = { v: 1, prevMarketKind: String(cfg.market.kind), prevSniper, sniperWasAbsent: sniper === undefined };
    writeAtomic(sidecarFile, record);
  }
  cfg.market.kind = "real-discovery";
  cfg.sniper = { ...(sniper ?? {}), ...PAPER_SNIPER_LIMITS };
  writeAtomic(cfgFile, cfg);
  return "enabled";
}
