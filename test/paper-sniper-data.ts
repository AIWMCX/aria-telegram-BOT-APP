/**
 * Paper sniper PR E: file reader robustness, summary math on a fixture ledger,
 * kill/resume flag files, and the /api/paper-sniper/* gate.
 * Run: npx tsx test/paper-sniper-data.ts
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readNewLines, readSniperSnapshot, readTailText, foldLedger, parseLedgerLines } from "../src/paper-sniper/data.js";
import { writeKillFlag, writeResumeFlag } from "../src/paper-sniper/control.js";
import { paperSniperRoutes } from "../src/paper-sniper/routes.js";
import { fixtureRows, missed, tmpRuntime, writeLedger } from "./paper-sniper-fixture.js";

let n = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`ok - ${name}`); });

const NOW = Date.parse("2026-10-24T12:00:00Z");
const base = NOW - 3_600_000;

await check("summary math matches hand-derived engine definitions", () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(base));
  writeFileSync(path.join(dir, "state", "sniper-marks.json"), JSON.stringify({ updatedAt: NOW, marks: [{ tradeId: "T3", valueLamports: "60000000", ts: NOW - 1000 }] }));
  const s = readSniperSnapshot(dir, { now: NOW });
  const m = s.main, b = s.baseline;
  assert.equal(m.closedTrades, 3);
  assert.equal(m.netClosedLamports, "-47679280"); // 19,785,000 - 15,320,000 - 52,144,280
  assert.equal(m.maxDrawdownLamports, "67464280"); // peak 19,785,000 -> trough -47,679,280
  assert.equal(m.missedCostLamports, "105000");
  assert.equal(m.netClosedAndMissedLamports, "-47784280");
  assert.equal(m.netInclOpenAtMarkLamports, "-37999280"); // + (-52,144,280 + 60M + 2,039,280 - 110,000)
  assert.equal(m.netInclOpenAtZeroLamports, "-99928560"); // + (-52,144,280)
  assert.equal(m.meanNetLamports, "-15893093");
  assert.equal(m.medianNetLamports, "-15320000");
  assert.equal(m.wins, 1);
  assert.equal(m.honeypotLosses, 1);
  assert.equal(m.missed, 2); assert.equal(m.missedMarket, 1); assert.equal(m.missedInfra, 1);
  assert.equal(m.openTrades, 1); assert.equal(m.openMarked, 1); assert.equal(m.openUnmarked, 0);
  assert.equal(b.closedTrades, 1); assert.equal(b.netClosedLamports, "-10215000");
  assert.deepEqual(s.skipReasons, [{ reason: "safety_block", count: 2 }, { reason: "kill_switch", count: 1 }]);
  assert.equal(s.open.length, 1); assert.equal(s.open[0]!.pnlAtMarkLamports, "9785000");
  assert.equal(s.recentClosed[0]!.exitReason, "honeypot_loss"); // newest first
  assert.equal(s.sample.insufficient, true); assert.equal(s.sample.min, 200);
  assert.ok(m.warnings.some((w) => w.startsWith("INSUFFICIENT SAMPLE: 3 closed")));
});

await check("stale or missing marks value open positions at zero in both lines", () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(base));
  writeFileSync(path.join(dir, "state", "sniper-marks.json"), JSON.stringify({ marks: [{ tradeId: "T3", valueLamports: "60000000", ts: NOW - 700_000 }] }));
  const s = readSniperSnapshot(dir, { now: NOW });
  assert.equal(s.main.openUnmarked, 1);
  assert.equal(s.main.netInclOpenAtMarkLamports, s.main.netInclOpenAtZeroLamports);
});

await check("reader tolerates a partial last line, missing files and garbage", () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(base), '{"v":1,"kind":"open","ts":1,"trade_id":"PARTI');
  const s = readSniperSnapshot(dir, { now: NOW });
  assert.equal(s.main.closedTrades, 3);
  assert.equal(readSniperSnapshot(tmpRuntime(), { now: NOW }).state, "no_data");
  writeFileSync(path.join(dir, "state", "sniper-status.json"), "{not json");
  writeFileSync(path.join(dir, "state", "sniper-marks.json"), "[1,2");
  assert.doesNotThrow(() => readSniperSnapshot(dir, { now: NOW }));
  assert.equal(parseLedgerLines(["nope", '{"v":2,"kind":"open"}', '{"v":1,"kind":"skip"}']).length, 1);
});

await check("huge ledger is bounded: only the newest window is folded and flagged truncated", () => {
  const dir = tmpRuntime();
  const rows = fixtureRows(base);
  const f = writeLedger(dir, rows);
  const size = statSync(f).size;
  const t = readTailText(f, Math.floor(size / 2))!;
  assert.equal(t.truncated, true);
  assert.ok(t.text.length < size);
  assert.ok(t.text.split("\n")[0]!.startsWith("{") && t.text.split("\n")[0]!.endsWith("}")); // starts on a line boundary
  const s = readSniperSnapshot(dir, { now: NOW, maxLedgerBytes: Math.floor(size / 2) });
  assert.equal(s.truncated, true);
  assert.ok(s.rows < rows.length);
});

await check("readNewLines never consumes a partial line and survives file shrink", () => {
  const dir = tmpRuntime();
  const f = writeLedger(dir, [{ v: 1, kind: "skip", ts: 1, reason: "a" }]);
  const r1 = readNewLines(f, 0)!;
  assert.equal(r1.lines.length, 1);
  appendFileSync(f, '{"v":1,"kind":"skip","ts":2,"rea');
  const r2 = readNewLines(f, r1.nextOffset)!;
  assert.equal(r2.lines.length, 0); assert.equal(r2.nextOffset, r1.nextOffset);
  appendFileSync(f, 'son":"b"}\n');
  const r3 = readNewLines(f, r2.nextOffset)!;
  assert.deepEqual(parseLedgerLines(r3.lines).map((x) => x.reason), ["b"]);
  assert.equal(readNewLines(f, 10_000_000)!.lines.length, 0);
  assert.equal(readNewLines(path.join(dir, "nope"), 0), undefined);
});

await check("fold: first open wins, sell after close ignored", () => {
  const b = foldLedger(parseLedgerLines(fixtureRows(base).map((r) => JSON.stringify(r))));
  assert.equal(b.trades.get("T1")!.mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(b.trades.get("T1")!.net, 19_785_000n);
  assert.equal(b.haltReason, null);
});

await check("status: kill flag wins, halt and stopped are reported", () => {
  const dir = tmpRuntime();
  writeLedger(dir, fixtureRows(base));
  const status = (o: object) => writeFileSync(path.join(dir, "state", "sniper-status.json"), JSON.stringify({ updatedAt: NOW - 1000, running: true, halt: null, feed: { ok: true, detail: "x" }, ...o }));
  status({});
  assert.equal(readSniperSnapshot(dir, { now: NOW }).state, "running");
  status({ halt: "consecutive_failures" });
  const h = readSniperSnapshot(dir, { now: NOW });
  assert.equal(h.state, "halted"); assert.match(h.reason, /consecutive_failures/);
  status({ updatedAt: NOW - 120_000 });
  assert.equal(readSniperSnapshot(dir, { now: NOW }).state, "stopped");
  status({});
  writeKillFlag(dir);
  assert.equal(readSniperSnapshot(dir, { now: NOW }).state, "killed");
});

await check("kill writes the KILL flag, resume removes it and writes RESUME", () => {
  const dir = tmpRuntime();
  writeKillFlag(dir, false);
  assert.ok(existsSync(path.join(dir, "KILL")));
  assert.equal(JSON.parse(readFileSync(path.join(dir, "KILL"), "utf8")).flatten, false);
  writeKillFlag(dir, true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "KILL"), "utf8")).flatten, true);
  writeResumeFlag(dir);
  assert.ok(!existsSync(path.join(dir, "KILL")));
  assert.ok(existsSync(path.join(dir, "RESUME")));
  writeResumeFlag(dir); // idempotent when KILL is already gone
});

await check("missed split: missed_inconsistent_read and missed_error are infrastructure, missed_no_route is market", () => {
  const dir = tmpRuntime();
  writeLedger(dir, [
    missed("Q1", base, "missed_inconsistent_read", "0"), missed("Q2", base + 1, "missed_error", "0"),
    missed("Q3", base + 2, "missed_no_route", "0"), missed("Q4", base + 3, "missed_landing_failed", "105000"),
  ]);
  const m = readSniperSnapshot(dir, { now: NOW }).main;
  assert.equal(m.missed, 4); assert.equal(m.missedInfra, 2); assert.equal(m.missedMarket, 2);
  assert.equal(m.missedByReason.missed_inconsistent_read, 1);
});

// ───────── API gate ─────────
const dir = tmpRuntime();
writeLedger(dir, fixtureRows(base));
const auth = (id: number, age = 0) => () => ({ user: { id }, auth_date: Math.floor(NOW / 1000) - age });
const mk = (o: Partial<Parameters<typeof paperSniperRoutes>[0]> = {}) => paperSniperRoutes({
  enabled: true, allowedTelegramIds: new Set(["42"]), authenticate: auth(42), resolveRuntimeDir: async (id) => (id === 42 ? dir : undefined), now: () => NOW, ...o,
});
const post = (app: ReturnType<typeof mk>, p: string, body: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const body = { initData: "x".repeat(20) };

await check("API: disabled is 404 for every route", async () => {
  for (const p of ["/status", "/summary", "/kill", "/resume"]) assert.equal((await post(mk({ enabled: false }), p, body)).status, 404);
  assert.equal((await post(mk({ allowedTelegramIds: new Set() }), "/status", body)).status, 404);
});

await check("API: non-allowed user gets 403 and can neither read nor kill", async () => {
  const app = mk({ authenticate: auth(7) });
  for (const p of ["/status", "/summary", "/kill", "/resume"]) assert.equal((await post(app, p, body)).status, 403);
  assert.equal((await post(mk({ authenticate: () => null }), "/summary", body)).status, 403);
  assert.equal((await post(mk({ authenticate: auth(42, 4000) }), "/summary", body)).status, 403); // stale initData
});

await check("API: strict zod rejects extra/missing fields before auth", async () => {
  const app = mk();
  assert.equal((await post(app, "/summary", { ...body, extra: 1 })).status, 400);
  assert.equal((await post(app, "/kill", { initData: "short" })).status, 400);
  assert.equal((await post(app, "/kill", { ...body, flatten: "yes" })).status, 400);
  assert.equal((await app.request("/summary", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
});

await check("API: allowed user reads a summary; kill/resume toggle the flag file", async () => {
  const app = mk();
  assert.deepEqual(await (await post(app, "/status", body)).json(), { ok: true, enabled: true, available: true });
  const r = await post(app, "/summary", body);
  assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.snapshot.main.closedTrades, 3);
  assert.equal((await post(app, "/kill", body)).status, 200);
  assert.ok(existsSync(path.join(dir, "KILL")));
  assert.equal(((await (await post(app, "/summary", body)).json()) as any).snapshot.state, "killed");
  assert.equal((await post(app, "/resume", body)).status, 200);
  assert.ok(!existsSync(path.join(dir, "KILL")));
});

await check("API: no tenant => status unavailable, kill 409; rate limit 429", async () => {
  const app = mk({ resolveRuntimeDir: async () => undefined });
  assert.equal(((await (await post(app, "/status", body)).json()) as any).available, false);
  assert.equal((await post(app, "/kill", body)).status, 409);
  const lim = mk({ writesPerMinute: 2 });
  assert.equal((await post(lim, "/resume", body)).status, 200);
  assert.equal((await post(lim, "/resume", body)).status, 200);
  assert.equal((await post(lim, "/resume", body)).status, 429);
});

await check("API: response never contains secrets or env values", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "1234567890:SECRETSECRETSECRET";
  const text = await (await post(mk(), "/summary", body)).text();
  assert.ok(!text.includes("SECRETSECRET"));
});

console.log(`${n} checks passed`);
