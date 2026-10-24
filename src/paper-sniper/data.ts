import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";

/**
 * READ-ONLY access to one tenant's paper-sniper files (PR E).
 *
 * Source of truth: the engine's append-only `state/sniper-ledger.jsonl`, plus
 * `state/sniper-marks.json` and `state/sniper-status.json`. This module does
 * NOT spawn `aria paper report`; it folds the ledger itself with a small TS
 * port of the engine's book + strategyReport (aria-engine
 * src/paper/sniper/sniper-book.ts and sniper-report.ts @ 4fadcd3):
 *   - same fold rules (first `open` wins, `sell` after close ignored, `missed`
 *     costs the failed-tx fee, partial sells accumulate, `final` sell closes);
 *   - same identity: net = sell_out - buy_in - fee_buy - fee_sell - rent - other_rent + rent_refunded;
 *   - same open valuation: "at zero" = paid so far; "at mark" = paid so far + last
 *     SELL-quote value (+ rent refund on close) - exit fee; marks older than 10 min
 *     or graduated_unpriced positions count as unmarked (zero in both lines);
 *   - same max-drawdown walk over closed trades ordered by exit_ts, same median
 *     (even count: mean of the two middle values, integer division), same
 *     missed market/infra split (infra = missed_error, missed_inconsistent_read),
 *     same 200-closed-trade sample floor.
 * NOT ported: the seeded bootstrap CI, the PAIRED view and profit factor
 * (the panel and Telegram texts do not show them).
 *
 * Safety: callers pass a runtimeDir derived from a validated clientId only
 * (FleetManager.runtimeDirFor); every file name here is a fixed constant.
 * Reads are bounded; a partial last line (writer mid-append) is ignored.
 */

export const MIN_GATE_TRADES = 200;
export const LEDGER_FILE = "sniper-ledger.jsonl";
export const MARKS_FILE = "sniper-marks.json";
export const STATUS_FILE = "sniper-status.json";
/** Ledger bytes folded in full. Above this only the newest window is folded and the result is flagged `truncated`. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 1024 * 1024;
const MARK_MAX_AGE_MS = 600_000;
const STATUS_FRESH_MS = 30_000;
const MISSED_INFRA: ReadonlySet<string> = new Set(["missed_error", "missed_inconsistent_read"]);
const DEFAULT_EXIT_FEE = 5000n + 100_000n + 5000n; // base + modelled priority + close fee (engine defaults)

type Strategy = "main" | "baseline";
type Json = Record<string, any>;

// ───────────────────────── bounded file reads ─────────────────────────

/** Reads at most `maxBytes` from the END of the file (whole file when smaller). Returns text starting at a line boundary. */
export function readTailText(file: string, maxBytes: number): { text: string; size: number; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, size - len + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    const truncated = size > len;
    if (truncated) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, size, truncated };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Reads new COMPLETE lines from `offset` (bounded by maxBytes). Returns the offset after the last complete line. */
export function readNewLines(file: string, offset: number, maxBytes = 4 * 1024 * 1024): { lines: string[]; nextOffset: number; size: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (offset > size) return { lines: [], nextOffset: size, size }; // file replaced/shrunk: resume at its end
    const len = Math.min(size - offset, maxBytes);
    if (len <= 0) return { lines: [], nextOffset: offset, size };
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const slice = buf.subarray(0, read);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], nextOffset: offset, size }; // only a partial line so far (or a line larger than maxBytes: skipped below)
    const complete = slice.subarray(0, lastNl + 1);
    return { lines: complete.toString("utf8").split("\n").filter((l) => l.length > 0), nextOffset: offset + lastNl + 1, size };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function readSmallJson(file: string): Json | undefined {
  try {
    if (statSync(file).size > MAX_SMALL_FILE_BYTES) return undefined;
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses ledger text; unparseable / foreign lines are skipped (the engine itself tolerates only a trailing partial line, we are stricter-free because we only read). */
export function parseLedgerLines(lines: Iterable<string>): Json[] {
  const rows: Json[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as unknown;
      if (typeof r === "object" && r !== null && (r as Json).v === 1 && typeof (r as Json).kind === "string") rows.push(r as Json);
    } catch { /* partial or corrupt line */ }
  }
  return rows;
}

// ───────────────────────── the fold (port of SniperBook) ─────────────────────────

export interface Trade {
  tradeId: string; strategy: Strategy; mint: string; source: string;
  detectSig: string; entryTs: number; exitTs: number | null;
  buyIn: bigint; tokensRaw: bigint; decimals: number; tokensRemaining: bigint;
  feeBuy: bigint; feeSell: bigint; rent: bigint; otherRent: bigint; rentRefunded: bigint; sellOut: bigint;
  net: bigint | null; status: "open" | "closed" | "missed"; missedReason: string | null; exitReason: string | null;
  graduatedUnpriced: boolean; safetyReport: unknown;
}

export interface Book {
  trades: Map<string, Trade>;
  skipCounts: Map<string, number>;
  skipTs: Array<{ ts: number; reason: string }>;
  haltReason: string | null;
  rows: number;
}

const big = (v: unknown): bigint => { try { return BigInt(v as string); } catch { return 0n; } };

export function foldLedger(rows: readonly Json[]): Book {
  const b: Book = { trades: new Map(), skipCounts: new Map(), skipTs: [], haltReason: null, rows: 0 };
  for (const r of rows) {
    b.rows++;
    switch (r.kind) {
      case "skip": {
        const reason = String(r.reason ?? "unknown");
        b.skipCounts.set(reason, (b.skipCounts.get(reason) ?? 0) + 1);
        b.skipTs.push({ ts: Number(r.ts) || 0, reason });
        break;
      }
      case "missed": {
        if (b.trades.has(r.trade_id)) break;
        const cost = big(r.cost_lamports);
        b.trades.set(r.trade_id, {
          tradeId: r.trade_id, strategy: r.strategy, mint: String(r.mint), source: String(r.source ?? ""), detectSig: String(r.detect_sig ?? ""),
          entryTs: Number(r.ts) || 0, exitTs: null, buyIn: 0n, tokensRaw: 0n, decimals: 0, tokensRemaining: 0n,
          feeBuy: cost, feeSell: 0n, rent: 0n, otherRent: 0n, rentRefunded: 0n, sellOut: 0n, net: -cost, status: "missed",
          missedReason: String(r.reason ?? "unknown"), exitReason: null, graduatedUnpriced: false, safetyReport: r.safety_report ?? null,
        });
        break;
      }
      case "open": {
        if (b.trades.has(r.trade_id)) break; // first write wins
        b.trades.set(r.trade_id, {
          tradeId: r.trade_id, strategy: r.strategy, mint: String(r.mint), source: String(r.source ?? ""), detectSig: String(r.detect_sig ?? ""),
          entryTs: Number(r.ts) || 0, exitTs: null, buyIn: big(r.buy_in_lamports), tokensRaw: big(r.tokens_raw), decimals: Number(r.decimals) || 0,
          tokensRemaining: big(r.tokens_raw), feeBuy: big(r.fee_buy), feeSell: 0n, rent: big(r.rent_lamports), otherRent: big(r.other_rent_lamports ?? "0"),
          rentRefunded: 0n, sellOut: 0n, net: null, status: "open", missedReason: null, exitReason: null, graduatedUnpriced: false, safetyReport: r.safety_report ?? null,
        });
        break;
      }
      case "sell": {
        const t = b.trades.get(r.trade_id);
        if (!t || t.status !== "open") break; // a sell after close is ignored
        t.sellOut += big(r.sell_out_lamports);
        t.feeSell += big(r.fee_sell);
        t.tokensRemaining -= big(r.tokens_sold_raw);
        if (r.final) {
          t.rentRefunded += big(r.rent_refunded);
          t.exitReason = String(r.reason ?? "unknown");
          t.exitTs = Number(r.ts) || 0;
          t.status = "closed";
          t.tokensRemaining = 0n;
          t.net = t.sellOut - t.buyIn - t.feeBuy - t.feeSell - t.rent - t.otherRent + t.rentRefunded;
        }
        break;
      }
      case "flag": {
        const t = b.trades.get(r.trade_id);
        if (t && t.status === "open") t.graduatedUnpriced = r.flag === "graduated_unpriced";
        break;
      }
      case "halt": b.haltReason = String(r.reason ?? "halt"); break;
      case "resume": b.haltReason = null; break;
      default: break; // hwm and unknown kinds do not affect the report
    }
  }
  return b;
}

// ───────────────────────── report (port of strategyReport) ─────────────────────────

export interface Mark { valueLamports: bigint; ts: number }
export interface ReportParams { marks: ReadonlyMap<string, Mark>; exitFeeLamports: bigint; refundRentOnClose: boolean }

export interface StrategySummary {
  strategy: Strategy;
  closedTrades: number; openTrades: number; wins: number; winRate: number | null;
  netClosedLamports: string; missedCostLamports: string;
  /** Closed-trade net minus the fee cost of missed fills (the engine's netLamportsTotal). */
  netClosedAndMissedLamports: string;
  netInclOpenAtMarkLamports: string; netInclOpenAtZeroLamports: string;
  meanNetLamports: string | null; medianNetLamports: string | null;
  maxDrawdownLamports: string; medianHoldMs: number | null;
  missed: number; missedMarket: number; missedInfra: number; missedRate: number | null;
  honeypotLosses: number; honeypotRate: number | null;
  openMarked: number; openUnmarked: number; graduatedUnpriced: number;
  exitReasons: Record<string, number>; missedByReason: Record<string, number>;
  warnings: string[];
}

function medianBig(xs: bigint[]): bigint | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, c) => (a < c ? -1 : a > c ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

export function summarizeStrategy(strategy: Strategy, trades: readonly Trade[], p: ReportParams): StrategySummary {
  const mine = trades.filter((t) => t.strategy === strategy);
  const closed = mine.filter((t) => t.status === "closed").sort((a, c) => a.exitTs! - c.exitTs!);
  const missed = mine.filter((t) => t.status === "missed");
  const open = mine.filter((t) => t.status === "open");
  const nets = closed.map((t) => t.net!);
  const sum = (xs: bigint[]) => xs.reduce((a, c) => a + c, 0n);
  let cum = 0n, peak = 0n, dd = 0n;
  for (const n of nets) { cum += n; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  const missedCost = sum(missed.map((t) => -t.net!));
  const filled = closed.length + open.length;
  const honeypots = closed.filter((t) => t.exitReason === "honeypot_loss").length;
  const count = (xs: Trade[], key: "missedReason" | "exitReason") => {
    const o: Record<string, number> = {};
    for (const t of xs) { const k = t[key] ?? "unknown"; o[k] = (o[k] ?? 0) + 1; }
    return o;
  };
  let atMark = 0n, atZero = 0n, marked = 0, unmarked = 0, grad = 0;
  for (const t of open) {
    const paid = t.sellOut - t.buyIn - t.feeBuy - t.feeSell - t.rent - t.otherRent;
    atZero += paid;
    const mk = t.graduatedUnpriced ? undefined : p.marks.get(t.tradeId);
    if (t.graduatedUnpriced) grad++;
    if (mk) { marked++; atMark += paid + mk.valueLamports + (p.refundRentOnClose ? t.rent : 0n) - p.exitFeeLamports; }
    else { unmarked++; atMark += paid; }
  }
  const medHold = medianBig(closed.map((t) => BigInt(t.exitTs! - t.entryTs)));
  const missedInfra = missed.filter((t) => MISSED_INFRA.has(t.missedReason ?? "")).length;
  const warnings: string[] = [];
  if (open.length > 0) warnings.push(`${open.length} open position(s) are excluded from win rate, drawdown and the closed-trade averages; see the "incl. open" lines`);
  if (unmarked > 0) warnings.push(`${unmarked} open position(s) have no usable mark and are valued at zero in both open lines`);
  if (grad > 0) warnings.push(`${grad} position(s) are graduated_unpriced: held and unpriced, not counted as honeypots`);
  if (closed.length < MIN_GATE_TRADES) warnings.push(`INSUFFICIENT SAMPLE: ${closed.length} closed trades < ${MIN_GATE_TRADES}. This is not a gate result`);
  const wins = nets.filter((n) => n > 0n).length;
  return {
    strategy, closedTrades: closed.length, openTrades: open.length, wins, winRate: closed.length ? wins / closed.length : null,
    netClosedLamports: sum(nets).toString(), missedCostLamports: missedCost.toString(), netClosedAndMissedLamports: (sum(nets) - missedCost).toString(),
    netInclOpenAtMarkLamports: (sum(nets) - missedCost + atMark).toString(), netInclOpenAtZeroLamports: (sum(nets) - missedCost + atZero).toString(),
    meanNetLamports: closed.length ? (sum(nets) / BigInt(closed.length)).toString() : null, medianNetLamports: medianBig(nets)?.toString() ?? null,
    maxDrawdownLamports: dd.toString(), medianHoldMs: medHold === null ? null : Number(medHold),
    missed: missed.length, missedMarket: missed.length - missedInfra, missedInfra, missedRate: missed.length + filled ? missed.length / (missed.length + filled) : null,
    honeypotLosses: honeypots, honeypotRate: closed.length ? honeypots / closed.length : null,
    openMarked: marked, openUnmarked: unmarked, graduatedUnpriced: grad,
    exitReasons: count(closed, "exitReason"), missedByReason: count(missed, "missedReason"), warnings,
  };
}

// ───────────────────────── tenant-level read ─────────────────────────

export type SniperState = "running" | "halted" | "killed" | "stopped" | "no_data";

export interface KillFlag { killed: boolean; flatten: boolean; at: number | null }

/** Same semantics as the engine's KillSwitch.check(): ENOENT = clear; any other stat failure counts as killed (fail closed). */
export function readKillFlag(runtimeDir: string): KillFlag {
  const p = path.join(runtimeDir, "KILL");
  let st;
  try { st = statSync(p); } catch (e: any) {
    if (e?.code === "ENOENT") return { killed: false, flatten: false, at: null };
    return { killed: true, flatten: false, at: null };
  }
  let flatten = false;
  try { flatten = JSON.parse(readFileSync(p, "utf8"))?.flatten === true; } catch { /* bare flag = plain kill */ }
  return { killed: true, flatten, at: st.mtimeMs };
}

export interface OpenPositionView {
  tradeId: string; strategy: Strategy; mint: string; source: string; entryTs: number;
  buyInLamports: string; markValueLamports: string | null; markAgeMs: number | null; pnlAtMarkLamports: string | null; graduatedUnpriced: boolean;
}
export interface ClosedTradeView { tradeId: string; strategy: Strategy; mint: string; exitReason: string; exitTs: number; netLamports: string; holdMs: number }

export interface SniperSnapshot {
  generatedAt: number;
  state: SniperState; reason: string;
  kill: KillFlag;
  statusAgeMs: number | null;
  feedOk: boolean | null;
  /** Ledger was larger than MAX_LEDGER_BYTES: only the newest window was folded. */
  truncated: boolean;
  ledgerBytes: number;
  rows: number;
  open: OpenPositionView[];
  recentClosed: ClosedTradeView[];
  main: StrategySummary;
  baseline: StrategySummary;
  skipReasons: Array<{ reason: string; count: number }>;
  sample: { closedMain: number; min: number; insufficient: boolean };
}

export interface ReadOpts { now?: number; sinceMs?: number; maxLedgerBytes?: number; recentClosed?: number }

function loadMarks(file: string, now: number): Map<string, Mark> {
  const m = new Map<string, Mark>();
  const j = readSmallJson(file);
  if (!j || !Array.isArray(j.marks)) return m;
  for (const x of j.marks) {
    try {
      if (typeof x?.tradeId === "string" && typeof x.ts === "number" && now - x.ts <= MARK_MAX_AGE_MS) m.set(x.tradeId, { valueLamports: BigInt(x.valueLamports), ts: x.ts });
    } catch { /* skip bad mark */ }
  }
  return m;
}

function exitParams(runtimeDir: string): { exitFeeLamports: bigint; refundRentOnClose: boolean } {
  const cfg = readSmallJson(path.join(runtimeDir, "config.json"));
  const s = cfg && typeof cfg.sniper === "object" && cfg.sniper !== null ? (cfg.sniper as Json) : {};
  const get = (k: string, d: bigint): bigint => { try { return s[k] === undefined ? d : BigInt(s[k]); } catch { return d; } };
  const fee = get("baseFeeLamports", 5000n) + get("priorityFeeLamports", 100_000n) + get("closeFeeLamports", 5000n);
  return { exitFeeLamports: fee > 0n ? fee : DEFAULT_EXIT_FEE, refundRentOnClose: s.simulateAtaClose === undefined ? true : s.simulateAtaClose === true };
}

const cache = new Map<string, { key: string; rows: Json[]; truncated: boolean; size: number }>();

/** Ledger rows, memoised by (size, mtime) so a polling panel does not re-parse an unchanged file. */
export function readLedgerCached(file: string, maxBytes: number): { rows: Json[]; truncated: boolean; size: number } {
  let st;
  try { st = statSync(file); } catch { cache.delete(file); return { rows: [], truncated: false, size: 0 }; }
  const key = `${st.size}:${st.mtimeMs}:${maxBytes}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  const t = readTailText(file, maxBytes);
  const res = { key, rows: t ? parseLedgerLines(t.text.split("\n").filter((l) => l.length > 0)) : [], truncated: t?.truncated ?? false, size: t?.size ?? 0 };
  if (cache.size > 16) cache.clear();
  cache.set(file, res);
  return res;
}

export function readSniperSnapshot(runtimeDir: string, opts: ReadOpts = {}): SniperSnapshot {
  const now = opts.now ?? Date.now();
  const stateDir = path.join(runtimeDir, "state");
  const ledgerFile = path.join(stateDir, LEDGER_FILE);
  const led = readLedgerCached(ledgerFile, opts.maxLedgerBytes ?? MAX_LEDGER_BYTES);
  const book = foldLedger(led.rows);
  const marks = loadMarks(path.join(stateDir, MARKS_FILE), now);
  const params: ReportParams = { marks, ...exitParams(runtimeDir) };
  const since = opts.sinceMs ?? 0;
  const all = [...book.trades.values()].filter((t) => t.entryTs >= since);
  const main = summarizeStrategy("main", all, params);
  const baseline = summarizeStrategy("baseline", all, params);

  const open: OpenPositionView[] = all.filter((t) => t.status === "open").sort((a, c) => c.entryTs - a.entryTs).map((t) => {
    const mk = t.graduatedUnpriced ? undefined : marks.get(t.tradeId);
    const paid = t.sellOut - t.buyIn - t.feeBuy - t.feeSell - t.rent - t.otherRent;
    return {
      tradeId: t.tradeId, strategy: t.strategy, mint: t.mint, source: t.source, entryTs: t.entryTs, buyInLamports: t.buyIn.toString(),
      markValueLamports: mk ? mk.valueLamports.toString() : null, markAgeMs: mk ? Math.max(0, now - mk.ts) : null,
      pnlAtMarkLamports: mk ? (paid + mk.valueLamports + (params.refundRentOnClose ? t.rent : 0n) - params.exitFeeLamports).toString() : null,
      graduatedUnpriced: t.graduatedUnpriced,
    };
  });
  const recentClosed: ClosedTradeView[] = all.filter((t) => t.status === "closed").sort((a, c) => c.exitTs! - a.exitTs!).slice(0, opts.recentClosed ?? 15).map((t) => ({
    tradeId: t.tradeId, strategy: t.strategy, mint: t.mint, exitReason: t.exitReason ?? "unknown", exitTs: t.exitTs!, netLamports: t.net!.toString(), holdMs: t.exitTs! - t.entryTs,
  }));
  const skipMap = new Map<string, number>();
  for (const s of book.skipTs) if (s.ts >= since) skipMap.set(s.reason, (skipMap.get(s.reason) ?? 0) + 1);
  const skipReasons = [...skipMap.entries()].map(([reason, count]) => ({ reason, count })).sort((a, c) => c.count - a.count).slice(0, 12);

  // Process state: the kill FLAG file is authoritative; the status file (rewritten every 5 s by the engine) says whether it is alive.
  const kill = readKillFlag(runtimeDir);
  const status = readSmallJson(path.join(stateDir, STATUS_FILE));
  const statusAgeMs = status && typeof status.updatedAt === "number" ? Math.max(0, now - status.updatedAt) : null;
  const alive = status !== undefined && status.running === true && statusAgeMs !== null && statusAgeMs <= STATUS_FRESH_MS;
  const feedOk = status && typeof status.feed?.ok === "boolean" ? (status.feed.ok as boolean) : null;
  let state: SniperState; let reason: string;
  if (kill.killed) { state = "killed"; reason = kill.flatten ? "kill flag set (flatten requested)" : "kill flag set: no new entries"; }
  else if (!status && led.rows.length === 0) { state = "no_data"; reason = "no sniper files yet: the tenant has not run the sniper"; }
  else if (!alive) { state = "stopped"; reason = status ? "engine not reporting (status file stale or marked stopped)" : "no status file; showing ledger only"; }
  else if (typeof status!.halt === "string" && status!.halt) { state = "halted"; reason = `halt: ${String(status!.halt).slice(0, 80)}`; }
  else if (feedOk === false) { state = "halted"; reason = `entries paused: ${String(status!.feed?.detail ?? "feed unhealthy").slice(0, 80)}`; }
  else { state = "running"; reason = "entries enabled"; }

  return {
    generatedAt: now, state, reason, kill, statusAgeMs, feedOk, truncated: led.truncated, ledgerBytes: led.size, rows: book.rows,
    open, recentClosed, main, baseline, skipReasons,
    sample: { closedMain: main.closedTrades, min: MIN_GATE_TRADES, insufficient: main.closedTrades < MIN_GATE_TRADES },
  };
}

export function sniperFilesExist(runtimeDir: string): boolean {
  return existsSync(path.join(runtimeDir, "state", LEDGER_FILE)) || existsSync(path.join(runtimeDir, "state", STATUS_FILE));
}
