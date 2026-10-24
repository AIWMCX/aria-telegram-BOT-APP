import { jupiterLink } from "../external-review/verification.js";
import type { SniperSnapshot, StrategySummary } from "./data.js";

/**
 * Telegram texts for the paper sniper. PAPER ONLY and deliberately sober: every
 * figure is a MODELLED paper result, nothing here promises or implies a gain.
 * No env value, URL with a key, or secret can reach these functions: inputs are
 * ledger fields and fixed strings. Alert text uses Telegram HTML (escaped).
 */

export const PAPER_SIGNAL_REMINDER =
  "PAPER signal. If you trade, you choose the amount and sign in your own wallet. Verify afterwards in the founder panel.";

export function solText(lamports: string | bigint | null | undefined, decimals = 4): string {
  if (lamports === null || lamports === undefined) return "n/a";
  const n = BigInt(lamports);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const scale = 10n ** BigInt(9 - decimals);
  const rounded = (a + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(decimals);
  const frac = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return `${neg && rounded !== 0n ? "-" : ""}${whole}.${frac} SOL`;
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function strategyBlock(label: string, s: StrategySummary): string[] {
  return [
    `${label}`,
    `  closed trades: ${s.closedTrades} (win rate ${pct(s.winRate)}), open now: ${s.openTrades}`,
    `  net incl. open, open AT MARK: ${solText(s.netInclOpenAtMarkLamports)}`,
    `  net incl. open, open AT ZERO: ${solText(s.netInclOpenAtZeroLamports)}`,
    `  max drawdown (closed): ${solText(s.maxDrawdownLamports)}`,
    `  missed fills: ${s.missed} (market ${s.missedMarket}, infrastructure ${s.missedInfra})`,
    `  honeypot losses: ${s.honeypotLosses}`,
  ];
}

export function formatDailyReport(day: SniperSnapshot, all: SniperSnapshot): string {
  const L: string[] = [
    "ARIA paper sniper - daily report",
    "PAPER ONLY: modelled fills, no real orders. Figures are model output, not results you can bank on.",
    `State now: ${all.state} (${all.reason})`,
    "",
    "LAST 24 HOURS",
    ...strategyBlock("MAIN", day.main),
    ...strategyBlock("BASELINE (fixed exits, comparison)", day.baseline),
    "",
    "ALL TIME",
    ...strategyBlock("MAIN", all.main),
    ...strategyBlock("BASELINE", all.baseline),
  ];
  if (all.skipReasons.length) L.push("", "Skips (all time, not trades): " + all.skipReasons.slice(0, 6).map((s) => `${s.reason} ${s.count}`).join(", "));
  if (all.truncated) L.push("", "Note: the ledger is very large; only its newest part was read.");
  if (all.sample.insufficient) {
    L.push("", `INSUFFICIENT SAMPLE: ${all.sample.closedMain} closed MAIN trades, fewer than ${all.sample.min}. This is not a gate result and says nothing reliable about an edge.`);
  }
  return L.join("\n");
}

export function formatOnDemandReport(all: SniperSnapshot): string {
  const L: string[] = [
    "ARIA paper sniper - report",
    "PAPER ONLY: modelled fills, no real orders.",
    `State: ${all.state} (${all.reason})`,
    "",
    ...strategyBlock("MAIN", all.main),
    ...strategyBlock("BASELINE (fixed exits, comparison)", all.baseline),
  ];
  if (all.open.length) {
    L.push("", "Open positions:");
    for (const p of all.open.filter((o) => o.strategy === "main").slice(0, 5)) {
      L.push(`  ${p.mint.slice(0, 6)}...${p.mint.slice(-4)} at mark ${solText(p.pnlAtMarkLamports)}`);
    }
  }
  if (all.skipReasons.length) L.push("", "Skips: " + all.skipReasons.slice(0, 6).map((s) => `${s.reason} ${s.count}`).join(", "));
  if (all.sample.insufficient) L.push("", `INSUFFICIENT SAMPLE: ${all.sample.closedMain} closed MAIN trades < ${all.sample.min}. Not a gate result.`);
  return L.join("\n");
}

// ───────────────────────── assisted-snipe alerts ─────────────────────────

interface SafetyCheck { name?: unknown; result?: unknown }

/** Compact safety line from the ledger's safety_report: which checks passed, which did not. */
export function safetySummary(report: unknown): string {
  const r = report as { pipeline?: { verdict?: unknown; checks?: SafetyCheck[]; error?: unknown }; signals?: Array<{ name?: unknown; verdict?: unknown }> } | null;
  const p = r?.pipeline;
  if (!p) return "not recorded";
  const checks = Array.isArray(p.checks) ? p.checks : [];
  const clean = (v: unknown) => String(v ?? "?").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 32);
  const passed = checks.filter((c) => c.result === "pass").map((c) => clean(c.name));
  const other = checks.filter((c) => c.result !== "pass").map((c) => `${clean(c.name)}=${clean(c.result)}`);
  const parts = [`verdict ${clean(p.verdict)}`];
  if (passed.length) parts.push(`passed: ${passed.join(", ")}`);
  if (other.length) parts.push(`not passed: ${other.join(", ")}`);
  const sig = Array.isArray(r?.signals) ? r!.signals!.map((s) => `${clean(s.name)}=${clean(s.verdict)}`) : [];
  if (sig.length) parts.push(`signals: ${sig.join(", ")}`);
  return parts.join("; ");
}

function tokenAmount(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = decimals > 0 ? (n % base).toString().padStart(decimals, "0").slice(0, 2) : "";
  return decimals > 0 ? `${whole}.${frac}` : String(whole);
}

export interface AlertMessage { html: string; url: string | null; urlLabel: string | null }

export interface EntryAlertInput {
  mint: string; source: string; tradeId: string; safetyReport: unknown;
  buyInLamports: string; tokensRaw: string; decimals: number; feeBuy: string; rentLamports: string; latencyMs: number;
}

export function formatEntryAlert(i: EntryAlertInput): AlertMessage {
  const buy = BigInt(i.buyInLamports);
  const tokens = BigInt(i.tokensRaw);
  let price = "n/a";
  if (tokens > 0n) {
    const perToken = (Number(buy) / 1e9) / (Number(tokens) / 10 ** i.decimals);
    if (Number.isFinite(perToken)) price = `${perToken.toPrecision(4)} SOL per token`;
  }
  const html = [
    "<b>PAPER SIGNAL - entry (MAIN strategy)</b>",
    `Token mint (tap to copy):\n<code>${escapeHtml(i.mint)}</code>`,
    `Source: ${escapeHtml(i.source)}`,
    `Safety: ${escapeHtml(safetySummary(i.safetyReport))}`,
    `Paper entry: ${solText(buy)} for ${escapeHtml(tokenAmount(i.tokensRaw, i.decimals))} tokens, about ${escapeHtml(price)}`,
    `Modelled fill delay ${Math.round(i.latencyMs)} ms; modelled fees ${solText(i.feeBuy)}, token-account rent ${solText(i.rentLamports)}`,
    "Paper risk limits: stop-loss -30%, max hold 30 min.",
    "",
    escapeHtml(PAPER_SIGNAL_REMINDER),
  ].join("\n");
  return { html, url: jupiterLink(i.mint, "buy"), urlLabel: "Open Jupiter (SOL to token)" };
}

export interface ExitAlertInput {
  mint: string; tradeId: string; reason: string; final: boolean; tier?: number;
  sellOutLamports: string; tokensSoldRaw: string; decimals: number; tradeNetLamports: string | null;
}

const NO_SELL_REASONS = new Set(["honeypot_loss", "exit_error_loss"]);

export function formatExitAlert(i: ExitAlertInput): AlertMessage {
  const cleanReason = i.reason.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 40) || "unknown";
  const lines = [
    `<b>PAPER SIGNAL - ${i.final ? "exit" : "partial exit"} (MAIN strategy)</b>`,
    `Token mint (tap to copy):\n<code>${escapeHtml(i.mint)}</code>`,
    `Reason: ${escapeHtml(cleanReason)}${i.tier !== undefined ? ` (tier ${i.tier})` : ""}`,
    `Paper exit: ${i.final ? "closes the position" : "sells part of it"}; modelled proceeds ${solText(i.sellOutLamports)} for ${escapeHtml(tokenAmount(i.tokensSoldRaw, i.decimals))} tokens`,
  ];
  if (i.final && i.tradeNetLamports !== null) lines.push(`Modelled result for this paper trade, after fees and rent: ${solText(i.tradeNetLamports)}`);
  const noSell = NO_SELL_REASONS.has(cleanReason);
  if (noSell) lines.push("The paper engine found no usable sell route for this token. A real sell may not be possible. Do not assume you can exit.");
  lines.push("", escapeHtml(PAPER_SIGNAL_REMINDER));
  return { html: lines.join("\n"), url: noSell ? null : jupiterLink(i.mint, "sell"), urlLabel: noSell ? null : "Open Jupiter (token to SOL)" };
}
