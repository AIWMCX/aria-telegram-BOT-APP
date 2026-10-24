import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LEDGER_FILE, MAX_LEDGER_BYTES, parseLedgerLines, readNewLines, readTailText } from "./data.js";
import { formatEntryAlert, formatExitAlert, type AlertMessage } from "./format.js";

/**
 * Assisted-snipe alerts (PR E). Tails the founder tenant's append-only paper
 * ledger and tells the allowed user, over Telegram, when the MAIN strategy
 * OPENS a paper position and when it EXITS one (full or partial), so the
 * founder can choose to mirror it by hand in their own wallet. This module
 * only reads files and calls the injected `send`; it can sign and send
 * nothing on chain.
 *
 *  - Started from the CURRENT end of the ledger the first time a tenant is
 *    seen (history is never replayed as alerts). The byte offset and the
 *    dedupe keys are then persisted in `<runtimeDir>/paper-sniper-alerts.json`
 *    so a restart neither repeats nor (within the persistence granularity of
 *    one tick) loses alerts.
 *  - Dedupe: entry = trade id; exit = trade id + row timestamp + final flag.
 *  - Rate limit: at most `perHour` messages per recipient per rolling hour.
 *    Excess alerts are dropped (they are time-critical, a late one is worse
 *    than none) and counted; one summary note is sent when room frees up.
 *  - A partial last line is never consumed until its newline arrives.
 */

const STATE_FILE = "paper-sniper-alerts.json";
const MAX_SENT_KEYS = 2000;

interface Acc {
  tradeId: string; mint: string; source: string; decimals: number;
  buyIn: bigint; feeBuy: bigint; rent: bigint; otherRent: bigint; sellOut: bigint; feeSell: bigint; closed: boolean;
}

interface TenantState {
  runtimeDir: string;
  offset: number;
  acc: Map<string, Acc>;
  sent: string[];
  sentSet: Set<string>;
  times: number[];
  suppressed: number;
}

export interface AlertServiceDeps {
  allowedIds: () => Iterable<string>;
  resolveRuntimeDir: (telegramId: string) => Promise<string | undefined>;
  send: (telegramId: string, msg: AlertMessage) => Promise<void>;
  sendNote: (telegramId: string, text: string) => Promise<void>;
  alertsPerHour: number;
  now?: () => number;
  log?: { warn: (o: Record<string, unknown>, m: string) => void };
  maxLedgerBytes?: number;
}

const big = (v: unknown): bigint => { try { return BigInt(v as string); } catch { return 0n; } };

export class AlertService {
  private readonly tenants = new Map<string, TenantState>();
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly d: AlertServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  /** One polling pass over every allowed user. Never throws. Re-entrancy safe. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const id of [...this.d.allowedIds()]) {
        try { await this.tickUser(id); } catch (err) { this.d.log?.warn({ errName: (err as Error)?.name }, "paper sniper alert pass failed for one user"); }
      }
    } finally { this.busy = false; }
  }

  private statePath(runtimeDir: string): string { return path.join(runtimeDir, STATE_FILE); }

  private persist(t: TenantState): void {
    try {
      mkdirSync(t.runtimeDir, { recursive: true, mode: 0o700 });
      const f = this.statePath(t.runtimeDir);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, offset: t.offset, sent: t.sent.slice(-MAX_SENT_KEYS) }), { mode: 0o600 });
      renameSync(tmp, f);
    } catch { /* best effort: worst case one repeat after a restart */ }
  }

  private remember(t: TenantState, key: string): void {
    t.sentSet.add(key);
    t.sent.push(key);
    if (t.sent.length > MAX_SENT_KEYS * 2) { t.sent = t.sent.slice(-MAX_SENT_KEYS); t.sentSet = new Set(t.sent); }
  }

  /** Builds the per-trade accumulators from history and decides the starting offset. Returns the rows that are NEW (after a persisted offset). */
  private async init(runtimeDir: string): Promise<{ t: TenantState; fresh: Json[] }> {
    const t: TenantState = { runtimeDir, offset: 0, acc: new Map(), sent: [], sentSet: new Set(), times: [], suppressed: 0 };
    let persistedOffset: number | undefined;
    try {
      const j = JSON.parse(readFileSync(this.statePath(runtimeDir), "utf8")) as { offset?: unknown; sent?: unknown };
      if (typeof j.offset === "number" && Number.isSafeInteger(j.offset) && j.offset >= 0) persistedOffset = j.offset;
      if (Array.isArray(j.sent)) for (const k of j.sent) if (typeof k === "string") this.remember(t, k);
    } catch { /* first sight of this tenant */ }

    const file = path.join(runtimeDir, "state", LEDGER_FILE);
    const tail = readTailText(file, this.d.maxLedgerBytes ?? MAX_LEDGER_BYTES);
    if (!tail) { t.offset = persistedOffset ?? 0; return { t, fresh: [] }; }
    const nl = tail.text.lastIndexOf("\n");
    const complete = nl >= 0 ? tail.text.slice(0, nl + 1) : "";
    const completeBytes = Buffer.byteLength(complete);
    const startByte = tail.size - Buffer.byteLength(tail.text); // byte position where `tail.text` begins in the file
    const endByte = startByte + completeBytes;
    const startAt = persistedOffset !== undefined && persistedOffset <= endByte ? persistedOffset : endByte; // no persisted state: everything existing is history
    const fresh: Json[] = [];
    let pos = startByte;
    for (const line of complete.split("\n")) {
      if (line.length === 0) { pos += 1; continue; }
      pos += Buffer.byteLength(line) + 1;
      const rows = parseLedgerLines([line]);
      if (rows.length === 0) continue;
      if (pos <= startAt) this.accumulate(t, rows[0]!);
      else fresh.push(rows[0]!);
    }
    t.offset = endByte; // every complete line is either history (accumulated) or in `fresh` (handled by the caller)
    return { t, fresh };
  }

  /** Folds a row into the per-trade accumulator (MAIN strategy only). Mirrors the engine's book arithmetic. */
  private accumulate(t: TenantState, r: Json): Acc | undefined {
    if (r.kind === "open" && r.strategy === "main") {
      if (t.acc.has(r.trade_id)) return undefined; // first open wins
      const a: Acc = {
        tradeId: String(r.trade_id), mint: String(r.mint), source: String(r.source ?? ""), decimals: Number(r.decimals) || 0,
        buyIn: big(r.buy_in_lamports), feeBuy: big(r.fee_buy), rent: big(r.rent_lamports), otherRent: big(r.other_rent_lamports ?? "0"), sellOut: 0n, feeSell: 0n, closed: false,
      };
      t.acc.set(a.tradeId, a);
      return a;
    }
    if (r.kind === "sell") {
      const a = t.acc.get(r.trade_id);
      if (!a || a.closed) return undefined;
      a.sellOut += big(r.sell_out_lamports);
      a.feeSell += big(r.fee_sell);
      if (r.final) a.closed = true;
      return a;
    }
    return undefined;
  }

  private async handle(telegramId: string, t: TenantState, r: Json): Promise<void> {
    const isOpen = r.kind === "open";
    const wasClosed = r.kind === "sell" ? t.acc.get(r.trade_id)?.closed === true : false;
    const a = this.accumulate(t, r);
    if (!a || wasClosed) return;
    let key: string; let msg: AlertMessage;
    if (isOpen) {
      key = `entry:${a.tradeId}`;
      if (t.sentSet.has(key)) return;
      msg = formatEntryAlert({
        mint: a.mint, source: a.source, tradeId: a.tradeId, safetyReport: r.safety_report, buyInLamports: a.buyIn.toString(), tokensRaw: String(r.tokens_raw ?? "0"),
        decimals: a.decimals, feeBuy: a.feeBuy.toString(), rentLamports: a.rent.toString(), latencyMs: Number(r.latency_ms) || 0,
      });
    } else {
      if (r.reason === "sell_failed" || big(r.tokens_sold_raw) === 0n) return; // a failed modelled sell is not an exit
      const final = r.final === true;
      key = `exit:${a.tradeId}:${Number(r.ts) || 0}:${final ? "f" : "p"}`;
      if (t.sentSet.has(key)) return;
      const net = final ? (a.sellOut - a.buyIn - a.feeBuy - a.feeSell - a.rent - a.otherRent + big(r.rent_refunded)).toString() : null;
      msg = formatExitAlert({
        mint: a.mint, tradeId: a.tradeId, reason: String(r.reason ?? "unknown"), final, tier: typeof r.tier === "number" ? r.tier : undefined,
        sellOutLamports: String(r.sell_out_lamports ?? "0"), tokensSoldRaw: String(r.tokens_sold_raw ?? "0"), decimals: a.decimals, tradeNetLamports: net,
      });
    }
    this.remember(t, key);
    const n = this.now();
    t.times = t.times.filter((x) => n - x < 3_600_000);
    if (t.times.length >= this.d.alertsPerHour) { t.suppressed++; return; }
    t.times.push(n);
    try { await this.d.send(telegramId, msg); } catch (err) {
      this.d.log?.warn({ errName: (err as Error)?.name }, "paper sniper alert could not be delivered");
    }
  }

  private async flushSuppressed(telegramId: string, t: TenantState): Promise<void> {
    if (t.suppressed === 0) return;
    const n = this.now();
    t.times = t.times.filter((x) => n - x < 3_600_000);
    if (t.times.length >= this.d.alertsPerHour) return;
    t.times.push(n);
    const count = t.suppressed;
    t.suppressed = 0;
    try {
      await this.d.sendNote(telegramId, `${count} paper signal(s) were not sent because the hourly alert limit (${this.d.alertsPerHour}) was reached. They are all in the founder panel.`);
    } catch { /* note is best effort */ }
  }

  private async tickUser(telegramId: string): Promise<void> {
    const runtimeDir = await this.d.resolveRuntimeDir(telegramId);
    if (!runtimeDir) { this.tenants.delete(telegramId); return; }
    let t = this.tenants.get(telegramId);
    let rows: Json[] = [];
    if (!t || t.runtimeDir !== runtimeDir) {
      const init = await this.init(runtimeDir);
      t = init.t;
      rows = init.fresh;
      this.tenants.set(telegramId, t);
      this.persist(t);
    } else {
      const file = path.join(runtimeDir, "state", LEDGER_FILE);
      const res = readNewLines(file, t.offset);
      if (!res) return;
      t.offset = res.nextOffset;
      rows = parseLedgerLines(res.lines);
    }
    for (const r of rows) await this.handle(telegramId, t, r);
    await this.flushSuppressed(telegramId, t);
    if (rows.length > 0 || t.suppressed === 0) this.persist(t);
  }
}

type Json = Record<string, any>;
