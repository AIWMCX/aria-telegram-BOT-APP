/**
 * Paper sniper PR E: assisted-snipe alerts (dedupe, rate limit, restart),
 * message content (no secrets, no profit claims), daily report scheduler with a
 * fake clock, and the Telegram command logic.
 * Run: npx tsx test/paper-sniper-alerts.ts
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AlertService } from "../src/paper-sniper/alerts.js";
import { handleSniperCommand, NOT_AVAILABLE, NO_TENANT } from "../src/paper-sniper/commands.js";
import { parsePaperSniperFlags } from "../src/paper-sniper/config.js";
import { DailyReportScheduler } from "../src/paper-sniper/scheduler.js";
import { formatDailyReport, formatEntryAlert, formatExitAlert, formatOnDemandReport, safetySummary, PAPER_SIGNAL_REMINDER, type AlertMessage } from "../src/paper-sniper/format.js";
import { readSniperSnapshot } from "../src/paper-sniper/data.js";
import { MINT_A, MINT_B, SAFETY, fixtureRows, open, sell, tmpRuntime, writeLedger } from "./paper-sniper-fixture.js";

let n = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`ok - ${name}`); });
const append = (f: string, rows: object[]) => appendFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const SECRET = "SUPERSECRETKEY123";
process.env.ARIA_STREAM_RPC_URL = `wss://rpc.example/?api-key=${SECRET}`;
process.env.TELEGRAM_BOT_TOKEN = `99:${SECRET}`;
const forbidden = (s: string) => assert.ok(!s.includes(SECRET) && !/api-key|wss:\/\//i.test(s), "no secret/URL with a key in a message");
const noClaims = (s: string) => assert.ok(!/profit|guarantee|earn |winning|moon|risk-free|can't lose/i.test(s), `no profit claims: ${s.slice(0, 80)}`);

const NOW0 = Date.parse("2026-10-24T12:00:00Z");

function mkService(dir: string, o: { perHour?: number; clock?: { t: number } } = {}) {
  const sent: Array<{ to: string; msg: AlertMessage }> = []; const notes: string[] = [];
  const clock = o.clock ?? { t: NOW0 };
  const svc = new AlertService({
    allowedIds: () => ["42"], resolveRuntimeDir: async () => dir, alertsPerHour: o.perHour ?? 50, now: () => clock.t,
    send: async (to, msg) => { sent.push({ to, msg }); }, sendNote: async (_to, t) => { notes.push(t); },
  });
  return { svc, sent, notes, clock };
}

await check("alerts: history is not replayed; a new MAIN open alerts once with mint, source, safety, Jupiter buy link and the reminder", async () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, fixtureRows(NOW0));
  const { svc, sent } = mkService(dir);
  await svc.tick();
  assert.equal(sent.length, 0);
  append(f, [open("N1", "main", MINT_A, NOW0 + 5000), open("BASE1", "baseline", MINT_B, NOW0 + 5001)]);
  await svc.tick();
  assert.equal(sent.length, 1, "baseline opens never alert");
  const m = sent[0]!;
  assert.equal(m.to, "42");
  assert.ok(m.msg.html.includes(`<code>${MINT_A}</code>`));
  assert.ok(m.msg.html.includes("pumpfun"));
  assert.ok(m.msg.html.includes("mint-authority") && m.msg.html.includes("liquidity-floor=skipped"));
  assert.ok(m.msg.html.includes("0.0500 SOL"));
  assert.ok(m.msg.html.includes(PAPER_SIGNAL_REMINDER));
  const u = new URL(m.msg.url!);
  assert.equal(u.origin, "https://jup.ag"); assert.equal(u.searchParams.get("buy"), MINT_A); assert.equal(u.searchParams.get("sell"), "So11111111111111111111111111111111111111112");
  forbidden(m.msg.html); noClaims(m.msg.html);
  await svc.tick();
  assert.equal(sent.length, 1, "dedupe: nothing new, nothing resent");
});

await check("alerts: exit alert carries the reason and a token-to-SOL link; partial and final are separate; failed sells are silent", async () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, []);
  const { svc, sent } = mkService(dir);
  await svc.tick();
  append(f, [open("X1", "main", MINT_A, NOW0 + 1)]);
  await svc.tick();
  append(f, [
    sell("X1", NOW0 + 10, "0", "105000", "sell_failed", false, "0", undefined, "0"),
    sell("X1", NOW0 + 20, "30000000", "105000", "tp_tier", false, "0", 1, "500000000"),
    sell("X1", NOW0 + 30, "5000000", "105000", "stop_loss", true, "2034280", undefined, "500000000"),
    sell("X1", NOW0 + 31, "5000000", "105000", "late_dup", true, "2034280", undefined, "500000000"),
  ]);
  await svc.tick();
  assert.equal(sent.length, 3, "entry + partial + final");
  const partial = sent[1]!.msg, fin = sent[2]!.msg;
  assert.ok(partial.html.includes("partial exit") && partial.html.includes("tp_tier") && partial.html.includes("tier 1"));
  assert.ok(fin.html.includes("stop_loss") && fin.html.includes("-0.0154 SOL"), fin.html); // net -15,425,000: the failed-sell row also paid 105,000 in fees
  assert.equal(new URL(fin.url!).searchParams.get("sell"), MINT_A);
  assert.equal(new URL(fin.url!).searchParams.get("buy"), "So11111111111111111111111111111111111111112");
  forbidden(fin.html); noClaims(fin.html);
});

await check("alerts: honeypot exit offers no sell link and warns", async () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, []);
  const { svc, sent } = mkService(dir);
  await svc.tick();
  append(f, [open("H1", "main", MINT_A, NOW0 + 1), sell("H1", NOW0 + 2, "0", "0", "honeypot_loss", true)]);
  await svc.tick();
  const last = sent[sent.length - 1]!.msg;
  assert.equal(last.url, null);
  assert.ok(last.html.includes("no usable sell route"));
});

await check("alerts: hourly rate limit drops the excess, then sends one summary note when the window frees", async () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, []);
  const { svc, sent, notes, clock } = mkService(dir, { perHour: 2 });
  await svc.tick();
  append(f, [open("R1", "main", MINT_A, NOW0 + 1), open("R2", "main", MINT_B, NOW0 + 2), open("R3", "main", MINT_A, NOW0 + 3), open("R4", "main", MINT_B, NOW0 + 4)]);
  await svc.tick();
  assert.equal(sent.length, 2);
  assert.equal(notes.length, 0, "no room for the note yet");
  clock.t += 3_600_001;
  await svc.tick();
  assert.equal(sent.length, 2, "dropped alerts are not resent late");
  assert.equal(notes.length, 1); assert.match(notes[0]!, /2 paper signal\(s\) were not sent/);
  forbidden(notes[0]!);
});

await check("alerts: restart resumes from the persisted offset: no repeat, no loss; partial line waits for its newline", async () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, []);
  const a = mkService(dir);
  await a.svc.tick();
  append(f, [open("P1", "main", MINT_A, NOW0 + 1)]);
  await a.svc.tick();
  assert.equal(a.sent.length, 1);
  // process restarts; meanwhile P2 opens, and P3 is only half written
  append(f, [open("P2", "main", MINT_B, NOW0 + 2)]);
  const p3 = JSON.stringify(open("P3", "main", MINT_A, NOW0 + 3));
  appendFileSync(f, p3.slice(0, 40));
  const b = mkService(dir);
  await b.svc.tick();
  assert.equal(b.sent.length, 1, "only P2 (P1 not repeated, partial P3 not parsed)");
  assert.ok(b.sent[0]!.msg.html.includes(MINT_B));
  assert.ok(existsSync(path.join(dir, "paper-sniper-alerts.json")));
  await b.svc.tick();
  assert.equal(b.sent.length, 1, "still waiting for the newline");
  appendFileSync(f, p3.slice(40) + "\n");
  await b.svc.tick();
  assert.equal(b.sent.length, 2, "P3 alerts once it is complete");
  assert.ok(b.sent[1]!.msg.html.includes(MINT_A));
});

await check("alerts: persisted dedupe keys suppress a repeat even if the offset is lost", async () => {
  const dir = tmpRuntime();
  writeLedger(dir, [open("D1", "main", MINT_A, NOW0 + 1)]);
  writeFileSync(path.join(dir, "paper-sniper-alerts.json"), JSON.stringify({ v: 1, offset: 0, sent: ["entry:D1"] }));
  const { svc, sent } = mkService(dir);
  await svc.tick();
  assert.equal(sent.length, 0, "entry:D1 was already alerted");
  const fresh = tmpRuntime();
  writeLedger(fresh, [open("D2", "main", MINT_A, NOW0 + 1)]);
  writeFileSync(path.join(fresh, "paper-sniper-alerts.json"), JSON.stringify({ v: 1, offset: 0, sent: [] }));
  const other = mkService(fresh);
  await other.svc.tick();
  assert.equal(other.sent.length, 1, "same state shape without the key does alert");
});

await check("alerts: a missing ledger and no tenant are harmless", async () => {
  const dir = tmpRuntime();
  const { svc, sent } = mkService(dir);
  await svc.tick();
  const none = new AlertService({ allowedIds: () => ["42"], resolveRuntimeDir: async () => undefined, alertsPerHour: 5, send: async () => { throw new Error("x"); }, sendNote: async () => {} });
  await none.tick();
  assert.equal(sent.length, 0);
});

await check("format: report and on-demand texts are plain, sober, flag INSUFFICIENT SAMPLE, show at-mark and at-zero", () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(NOW0 - 3_600_000));
  const all = readSniperSnapshot(dir, { now: NOW0 });
  const day = readSniperSnapshot(dir, { now: NOW0, sinceMs: NOW0 - 86_400_000 });
  const t = formatDailyReport(day, all);
  for (const s of [t, formatOnDemandReport(all)]) {
    assert.ok(s.includes("PAPER ONLY")); assert.ok(s.includes("INSUFFICIENT SAMPLE: 3 closed MAIN trades"));
    assert.ok(s.includes("AT MARK") && s.includes("AT ZERO") && s.includes("max drawdown") && s.includes("market 1, infrastructure 1") && s.includes("honeypot losses: 1"));
    forbidden(s); noClaims(s);
  }
  assert.ok(t.includes("safety_block 2"));
  assert.equal(safetySummary(SAFETY).includes("passed: mint-authority, freeze-authority"), true);
  assert.equal(safetySummary(null), "not recorded");
  const e = formatEntryAlert({ mint: MINT_A, source: "<b>x</b>", tradeId: "t", safetyReport: SAFETY, buyInLamports: "50000000", tokensRaw: "1000000000", decimals: 6, feeBuy: "105000", rentLamports: "2039280", latencyMs: 2500 });
  assert.ok(!e.html.includes("<b>x</b>"), "ledger text is HTML-escaped");
  assert.ok(formatExitAlert({ mint: MINT_A, tradeId: "t", reason: "stop_loss", final: true, sellOutLamports: "1", tokensSoldRaw: "1", decimals: 0, tradeNetLamports: "-1" }).html.includes(PAPER_SIGNAL_REMINDER));
});

await check("scheduler: fires once at the configured UTC hour, not before, not twice, not hours late; survives restart via persisted day", async () => {
  let t = Date.parse("2026-10-24T12:59:00Z"); let last: string | undefined; let runs = 0;
  const mk = () => new DailyReportScheduler({ hourUtc: 13, now: () => t, loadLastDay: () => last, saveLastDay: (d) => { last = d; }, run: async () => { runs++; } });
  const s = mk();
  assert.equal(await s.tick(), false); assert.equal(runs, 0);
  t = Date.parse("2026-10-24T13:00:05Z");
  assert.equal(await s.tick(), true); assert.equal(runs, 1);
  t += 60_000; assert.equal(await s.tick(), false);
  assert.equal(await mk().tick(), false, "a restarted process does not resend"); assert.equal(runs, 1);
  t = Date.parse("2026-10-25T13:30:00Z");
  assert.equal(await mk().tick(), true); assert.equal(runs, 2);
  t = Date.parse("2026-10-26T20:00:00Z");
  assert.equal(await mk().tick(), false, "restart 7h after the slot: skipped, not sent late"); assert.equal(runs, 2);
});

await check("commands: /paper_report, /kill, /resume are allow-list only; kill writes and resume clears the flag", async () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(NOW0 - 3_600_000));
  const flags = parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "42" });
  const deps = { flags, resolveRuntimeDir: async (id: number) => (id === 42 ? dir : undefined) };
  for (const k of ["paper_report", "kill", "resume"] as const) {
    assert.equal(await handleSniperCommand(k, deps, 7), NOT_AVAILABLE);
    assert.equal(await handleSniperCommand(k, deps, undefined), NOT_AVAILABLE);
    assert.equal(await handleSniperCommand(k, { ...deps, flags: parsePaperSniperFlags({}) }, 42), NOT_AVAILABLE);
  }
  assert.ok(!existsSync(path.join(dir, "KILL")), "denied kill wrote nothing");
  assert.equal(await handleSniperCommand("kill", { ...deps, resolveRuntimeDir: async () => undefined }, 42), NO_TENANT);
  assert.match(await handleSniperCommand("paper_report", deps, 42), /ARIA paper sniper - report/);
  assert.match(await handleSniperCommand("kill", deps, 42), /KILL flag written/);
  assert.ok(existsSync(path.join(dir, "KILL")));
  assert.match(await handleSniperCommand("resume", deps, 42), /cleared/);
  assert.ok(!existsSync(path.join(dir, "KILL")));
  await handleSniperCommand("kill", deps, 42, "flatten");
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(path.join(dir, "KILL"), "utf8")).flatten, true);
});

console.log(`${n} checks passed`);
