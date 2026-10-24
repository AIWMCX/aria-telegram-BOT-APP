import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Shared fixture for the paper sniper tests. Numbers are derived by hand in test/paper-sniper-data.ts. */
export const MINT_A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MINT_B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const MINT_C = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const MINT_D = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
export const MINT_E = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

const DET = (mint: string, sig: string) => ({ mint, source: "pumpfun", detect_slot: 100, detect_sig: sig, detect_ts: 1 });
export const SAFETY = { pipeline: { verdict: "PASS", blockedBy: [], fromCache: false, checks: [
  { name: "mint-authority", result: "pass", detail: "" }, { name: "freeze-authority", result: "pass", detail: "" }, { name: "liquidity-floor", result: "skipped", detail: "x" } ] }, signals: [] };

export const open = (id: string, strategy: "main" | "baseline", mint: string, ts: number, sig = "s" + id) => ({
  v: 1, kind: "open", ts, trade_id: id, strategy, ...DET(mint, sig), safety_report: SAFETY, quote1_out_raw: "1000", quote2_out_raw: "990",
  latency_ms: 2500, buy_in_lamports: "50000000", tokens_raw: "1000000000", decimals: 6, fee_buy: "105000", rent_lamports: "2039280", venue: "pump", token_program: "t",
});
export const sell = (id: string, ts: number, out: string, fee: string, reason: string, final: boolean, refunded = "0", tier?: number, tokens = "1000000000") => ({
  v: 1, kind: "sell", ts, trade_id: id, tokens_sold_raw: tokens, sell_out_lamports: out, fee_sell: fee, cost_released_lamports: "0", reason, final, rent_refunded: refunded, ...(tier !== undefined ? { tier } : {}),
});
export const missed = (id: string, ts: number, reason: string, cost: string) => ({ v: 1, kind: "missed", ts, trade_id: id, strategy: "main", ...DET(MINT_E, "m" + id), reason, detail: "d", latency_ms: 1, cost_lamports: cost });
export const skip = (ts: number, reason: string) => ({ v: 1, kind: "skip", ts, strategy: "all", reason, ...DET(MINT_E, "k" + ts) });

/** T1 win, T2 loss (partial + final), T3 still open, T4 honeypot, 2 missed, B1 baseline loss, 3 skips, noise rows. */
export function fixtureRows(base: number): object[] {
  const t = (n: number) => base + n * 1000;
  return [
    skip(t(0), "safety_block"), skip(t(1), "safety_block"), skip(t(2), "kill_switch"),
    open("T1", "main", MINT_A, t(10)), open("T1", "main", MINT_B, t(11)), // duplicate open: first wins
    { v: 1, kind: "hwm", ts: t(11), trade_id: "T1", hwm_bps: 500, trailing_active: false },
    sell("T1", t(20), "70000000", "105000", "take_profit", true, "2034280"),
    sell("T1", t(21), "99999999", "105000", "late_dup", true, "2034280"), // sell after close: ignored
    open("T2", "main", MINT_B, t(12)),
    sell("T2", t(22), "30000000", "105000", "tp_tier", false, "0", 1, "500000000"),
    sell("T2", t(30), "5000000", "105000", "stop_loss", true, "2034280", undefined, "500000000"),
    open("T3", "main", MINT_C, t(40)),
    open("T4", "main", MINT_D, t(13)),
    sell("T4", t(50), "0", "0", "honeypot_loss", true, "0"),
    missed("M1", t(14), "missed_slippage", "105000"), missed("M2", t(15), "missed_error", "0"),
    open("B1", "baseline", MINT_A, t(10), "sB1"),
    sell("B1", t(25), "40000000", "105000", "stop_loss", true, "2034280"),
    { v: 1, kind: "halt", ts: t(60), reason: "consecutive_failures" }, { v: 1, kind: "resume", ts: t(61) },
  ];
}

export function tmpRuntime(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psn-"));
  mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
}

export function writeLedger(runtimeDir: string, rows: object[], tail = ""): string {
  const f = path.join(runtimeDir, "state", "sniper-ledger.jsonl");
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail);
  return f;
}
