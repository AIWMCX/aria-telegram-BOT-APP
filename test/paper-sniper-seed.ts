/**
 * Paper sniper PR E: env flags (fail closed), atomic config seeding on/off, the
 * allow-list, and the pre-spawn preparer.
 * Run: npx tsx test/paper-sniper-seed.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PaperSniperConfigError, parsePaperSniperFlags } from "../src/paper-sniper/config.js";
import { PAPER_SNIPER_LIMITS, SNIPER_SEED_SIDECAR, reconcileTenantSniperSync } from "../src/fleet/tenant-sniper-seed.js";
import { createSniperTenantPreparer, sniperUnavailableReason } from "../src/paper-sniper/tenant-prepare.js";

let n = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`ok - ${name}`); });
const FEED = "/data/discovery/launches.ndjson";

const engineCfg = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, rpc: { url: "https://rpc.example" }, paper: { startingBalanceSol: 1 }, market: { kind: "synthetic", watchlist: [] },
  discovery: { source: "file-tail", path: FEED }, ...extra,
});
function tenant(cfg: unknown): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "psn-seed-"));
  writeFileSync(path.join(d, "config.json"), JSON.stringify(cfg));
  return d;
}
const read = (d: string) => JSON.parse(readFileSync(path.join(d, "config.json"), "utf8"));

await check("flags: default off; enabled needs a non-blank valid allow-list (fail closed)", () => {
  assert.equal(parsePaperSniperFlags({}).enabled, false);
  assert.equal(parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "false", PAPER_SNIPER_TELEGRAM_IDS: "garbage" }).allowedTelegramIds.size, 0);
  assert.throws(() => parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true" }), PaperSniperConfigError);
  assert.throws(() => parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "   " }), /fail closed/);
  assert.throws(() => parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "12,abc" }), PaperSniperConfigError);
  assert.throws(() => parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "maybe", PAPER_SNIPER_TELEGRAM_IDS: "1" }), PaperSniperConfigError);
  assert.throws(() => parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "1", PAPER_SNIPER_REPORT_HOUR_UTC: "24" }), /0-23/);
  const ok = parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "1", PAPER_SNIPER_TELEGRAM_IDS: "42, 77", PAPER_SNIPER_REPORT_HOUR_UTC: "9", PAPER_SNIPER_ALERTS_PER_HOUR: "5" });
  assert.deepEqual([...ok.allowedTelegramIds], ["42", "77"]); assert.equal(ok.reportHourUtc, 9); assert.equal(ok.alertsPerHour, 5);
  assert.equal(parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "1" }).reportHourUtc, 13);
  // The error text must not echo arbitrary values.
  try { parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "1", PAPER_SNIPER_ALERTS_PER_HOUR: "sk-live-SECRET" }); assert.fail(); } catch (e) { assert.ok(!String((e as Error).message).includes("SECRET")); }
});

await check("seed on: sets market.kind and the confirmed engine keys, nothing else", () => {
  const d = tenant(engineCfg());
  assert.equal(reconcileTenantSniperSync({ runtimeDir: d, feedPath: FEED, enabled: true }), "enabled");
  const c = read(d);
  assert.equal(c.market.kind, "real-discovery");
  assert.deepEqual(c.sniper, { buyLamports: "50000000", maxOpen: 3, maxExposureLamports: "300000000", dailyLossHaltLamports: "150000000", stopLossBps: 3000, maxHoldMs: 1800000 });
  assert.deepEqual(c.discovery, { source: "file-tail", path: FEED });
  assert.deepEqual(c.rpc, { url: "https://rpc.example" });
  assert.ok(existsSync(path.join(d, SNIPER_SEED_SIDECAR)));
  assert.equal(reconcileTenantSniperSync({ runtimeDir: d, feedPath: FEED, enabled: true }), "unchanged"); // idempotent
  assert.ok(!readdirSync(d).some((f) => f.includes(".tmp-")), "no temp file left behind");
  assert.equal(Object.keys(PAPER_SNIPER_LIMITS).length, 6);
});

await check("seed off reverts ONLY what we set (and keeps operator edits)", () => {
  const d = tenant(engineCfg({ sniper: { latencyMs: 1234, maxOpen: 9 } }));
  reconcileTenantSniperSync({ runtimeDir: d, feedPath: FEED, enabled: true });
  const mid = read(d);
  assert.equal(mid.sniper.latencyMs, 1234); assert.equal(mid.sniper.maxOpen, 3);
  mid.sniper.stopLossBps = 2500; // operator changed one value after we seeded
  writeFileSync(path.join(d, "config.json"), JSON.stringify(mid));
  assert.equal(reconcileTenantSniperSync({ runtimeDir: d, feedPath: FEED, enabled: false }), "disabled");
  const c = read(d);
  assert.equal(c.market.kind, "synthetic");
  assert.equal(c.sniper.maxOpen, 9); // restored previous value
  assert.equal(c.sniper.latencyMs, 1234); // untouched
  assert.equal(c.sniper.stopLossBps, 2500); // operator value kept
  assert.equal(c.sniper.buyLamports, undefined);
  assert.ok(!existsSync(path.join(d, SNIPER_SEED_SIDECAR)));
  const e = tenant(engineCfg());
  reconcileTenantSniperSync({ runtimeDir: e, feedPath: FEED, enabled: true });
  reconcileTenantSniperSync({ runtimeDir: e, feedPath: FEED, enabled: false });
  assert.deepEqual(read(e), engineCfg()); // byte-for-byte shape restored incl. no sniper key
});

await check("a tenant we never seeded is never touched by a disable", () => {
  const d = tenant(engineCfg({ market: { kind: "real-discovery", watchlist: [] }, sniper: { maxOpen: 3 } }));
  const before = readFileSync(path.join(d, "config.json"), "utf8");
  assert.equal(reconcileTenantSniperSync({ runtimeDir: d, feedPath: FEED, enabled: false }), "unchanged");
  assert.equal(readFileSync(path.join(d, "config.json"), "utf8"), before);
});

await check("seed requires the shared feed and a real engine config", () => {
  const polling = tenant(engineCfg({ discovery: { source: "polling" } }));
  assert.equal(reconcileTenantSniperSync({ runtimeDir: polling, feedPath: FEED, enabled: true }), "no_feed");
  assert.equal(read(polling).market.kind, "synthetic");
  const other = tenant(engineCfg({ discovery: { source: "file-tail", path: "/elsewhere.ndjson" } }));
  assert.equal(reconcileTenantSniperSync({ runtimeDir: other, feedPath: FEED, enabled: true }), "no_feed");
  const junk = tenant({ hello: "world" });
  assert.equal(reconcileTenantSniperSync({ runtimeDir: junk, feedPath: FEED, enabled: true }), "deferred");
  assert.deepEqual(read(junk), { hello: "world" });
  const empty = mkdtempSync(path.join(os.tmpdir(), "psn-seed-"));
  assert.equal(reconcileTenantSniperSync({ runtimeDir: empty, feedPath: FEED, enabled: true }), "deferred");
  const bad = mkdtempSync(path.join(os.tmpdir(), "psn-seed-")); mkdirSync(bad, { recursive: true });
  writeFileSync(path.join(bad, "config.json"), "{broken");
  assert.equal(reconcileTenantSniperSync({ runtimeDir: bad, feedPath: FEED, enabled: true }), "deferred");
});

await check("preparer: only allow-listed owners are seeded; others untouched", async () => {
  const flags = parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "42" });
  const owners: Record<string, string | undefined> = { founder: "42", other: "99" };
  const prep = createSniperTenantPreparer({ flags, discoveryUsable: () => true, engineHasSniper: () => true, feedPath: FEED, ownerTelegramId: async (c) => owners[c] });
  const f = tenant(engineCfg()), o = tenant(engineCfg()), g = tenant(engineCfg());
  assert.equal(await prep.prepare("founder", f), "enabled");
  assert.equal(await prep.prepare("other", o), "unchanged");
  assert.equal(await prep.prepare("ghost", g), "unchanged");
  assert.equal(read(f).market.kind, "real-discovery");
  assert.equal(read(o).market.kind, "synthetic"); assert.equal(read(o).sniper, undefined);
  assert.equal(prep.seededCount(), 1);
  // allow-list shrinks: the founder id is removed => reverted at next spawn
  const shrunk = createSniperTenantPreparer({ flags: parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "7" }), discoveryUsable: () => true, engineHasSniper: () => true, feedPath: FEED, ownerTelegramId: async () => "42" });
  assert.equal(await shrunk.prepare("founder", f), "disabled");
  assert.equal(read(f).market.kind, "synthetic");
});

await check("preparer: disabling the switch, discovery or engine support reverts; lookup error leaves config alone", async () => {
  const on = parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "42" });
  const mkp = (o: Partial<Parameters<typeof createSniperTenantPreparer>[0]> = {}) => createSniperTenantPreparer({ flags: on, discoveryUsable: () => true, engineHasSniper: () => true, feedPath: FEED, ownerTelegramId: async () => "42", ...o });
  for (const off of [{ flags: parsePaperSniperFlags({}) }, { discoveryUsable: () => false }, { engineHasSniper: () => false }]) {
    const d = tenant(engineCfg());
    await mkp().prepare("c", d);
    assert.equal(read(d).market.kind, "real-discovery");
    assert.equal(await mkp(off).prepare("c", d), "disabled");
    assert.equal(read(d).market.kind, "synthetic");
  }
  const d = tenant(engineCfg());
  await mkp().prepare("c", d);
  assert.equal(await mkp({ ownerTelegramId: async () => { throw new Error("db down"); } }).prepare("c", d), "skipped");
  assert.equal(read(d).market.kind, "real-discovery");
});

await check("healthz reason: names the missing piece and never a value", () => {
  const base = { flags: parsePaperSniperFlags({ PAPER_SNIPER_ENABLED: "true", PAPER_SNIPER_TELEGRAM_IDS: "42" }), discoveryUsable: () => true, engineHasSniper: () => true };
  assert.equal(sniperUnavailableReason(base, true), undefined);
  assert.match(sniperUnavailableReason({ ...base, flags: parsePaperSniperFlags({}) }, true)!, /PAPER_SNIPER_ENABLED/);
  assert.match(sniperUnavailableReason(base, false)!, /FLEET_ENABLED/);
  assert.match(sniperUnavailableReason({ ...base, discoveryUsable: () => false }, true)!, /discovery/);
  assert.match(sniperUnavailableReason({ ...base, engineHasSniper: () => false }, true)!, /ARIA_ENGINE_COMMIT_SHA/);
});

console.log(`${n} checks passed`);
