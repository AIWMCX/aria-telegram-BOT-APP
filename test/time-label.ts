import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/time-label.js', 'utf8');
const win: Record<string, any> = {};
vm.runInNewContext(source, { window: win });
const TL = win.ARIATimeLabel;
assert.ok(TL, 'ARIATimeLabel exported');

const now = Date.parse('2026-10-23T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

// timeAgo: seconds, minutes, hours, days.
assert.equal(TL.timeAgo(ago(5 * S), now), '5s ago');
assert.equal(TL.timeAgo(ago(59 * S), now), '59s ago');
assert.equal(TL.timeAgo(ago(27 * M), now), '27m ago');
assert.equal(TL.timeAgo(ago(3 * H + 12 * M), now), '3h 12m ago');
assert.equal(TL.timeAgo(ago(27021 * M), now), '18d 18h ago', '27021 minutes must not render as minutes');
assert.equal(TL.timeAgo(ago(2 * D), now), '2d 0h ago');
assert.equal(TL.timeAgo(null, now), 'never');
assert.equal(TL.timeAgo('garbage', now), 'unknown');
assert.equal(TL.timeAgo(new Date(now + 5000).toISOString(), now), 'just now');

// Stale threshold: strictly older than 5 minutes.
assert.equal(TL.STALE_AFTER_MS, 300000);
assert.equal(TL.isStale([ago(5 * M)], now), false, 'exactly 5 minutes is not stale');
assert.equal(TL.isStale([ago(5 * M + 1)], now), true, 'just over 5 minutes is stale');
assert.equal(TL.isStale([ago(10 * S)], now), false);
// Freshest of the inputs wins; missing inputs are not stale.
assert.equal(TL.isStale([ago(19 * D), ago(1 * M)], now), false, 'recent device sync keeps data fresh');
assert.equal(TL.isStale([ago(19 * D), ago(18 * D)], now), true);
assert.equal(TL.isStale([null, null], now), false);
assert.equal(TL.isStale([null, ago(19 * D)], now), true);

// Labels: only a live data mode can become STALE.
const old = ago(19 * D);
const stale = TL.dataLabel('REAL MARKET DATA', 'live', [old], now);
assert.match(stale, /^STALE · last update /);
assert.ok(stale.includes(new Date(old).toLocaleString()), 'shows the local date time of the last update');
assert.equal(TL.dataLabel('REAL MARKET DATA', 'live', [ago(30 * S)], now), 'REAL MARKET DATA');
assert.equal(TL.dataLabel('SIMULATED', 'simulated', [old], now), 'SIMULATED');
assert.equal(TL.dataLabel('WAITING FOR ENGINE', 'unavailable', [old], now), 'WAITING FOR ENGINE');
assert.equal(TL.snapshotText(ago(27021 * M), now), 'SNAPSHOT 18d 18h ago · STALE');
assert.equal(TL.snapshotText(ago(20 * S), now), 'SNAPSHOT 20s ago');

// Integration: shipped app.js with an old snapshot must not keep saying REAL MARKET DATA.
async function run(snapshotAge: number, lastSeenAge: number) {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.indexOf('time-label.js') > 0 && html.indexOf('time-label.js') < html.indexOf('"app.js"'), 'time-label.js loads before app.js');
  const nodes = new Map<string, any>();
  const el = () => ({ textContent: '', value: '', disabled: false, hidden: false, className: '', style: {}, children: [] as any[], classList: { add() {}, remove() {} },
    append(...n: any[]) { this.children.push(...n); }, appendChild(n: any) { this.children.push(n); return n; }, removeChild() {}, get firstChild() { return null; },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, scrollIntoView() {} });
  const document = { getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); }, querySelectorAll: () => [], createElement: el, execCommand: () => true };
  const t = Date.now();
  const iso = (age: number) => new Date(t - age).toISOString();
  const fetch = async (url: string) => {
    if (url === '/api/product-reality') return { ok: true, json: async () => ({ ok: true, reality: { environment: 'production', network: 'solana-mainnet', dataMode: 'live', executionMode: 'paper', controlState: 'running', paymentsEnabled: false } }) };
    if (url === '/api/engine/me') return { ok: true, json: async () => ({ ok: true, paired: true, device: { id: 'd', online: false, engineVersion: '0.7.0', platform: 'win32', lastSeenAt: iso(lastSeenAge) }, entitlement: { status: 'active' }, snapshot: { receivedAt: iso(snapshotAge), data: { mode: 'paper', openPositionCount: 0, openExposureLamports: '0', realizedPnlLamports: '0', unrealizedPnlLamports: '0', openedCount: 1, closedCount: 1, rejectedCount: 1 } }, events: [], capabilities: {} }) };
    if (url === '/api/me') return { ok: true, json: async () => ({ ok: true, hasAccount: false, license: null }) };
    throw new Error('unexpected fetch ' + url);
  };
  const ctx = vm.createContext({ console, document, window: { Telegram: { WebApp: { ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, initData: 'user=1&auth_date=1&hash=x' } }, innerHeight: 800 },
    navigator: { clipboard: { writeText: async () => undefined } }, AbortController, setTimeout: () => 1, clearTimeout: () => undefined, setInterval: () => 1, fetch, Date });
  vm.runInContext(source, ctx);
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), ctx);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  return { mode: nodes.get('data-mode').textContent as string, market: nodes.get('status-market').textContent as string, uptime: nodes.get('uptime').textContent as string };
}
const fresh = await run(30 * S, 30 * S);
assert.equal(fresh.mode, 'REAL MARKET DATA'); assert.equal(fresh.market, 'REAL MARKET DATA'); assert.equal(fresh.uptime, 'SNAPSHOT 30s ago');
const staleRun = await run(27021 * M, 27021 * M);
assert.match(staleRun.mode, /^STALE · last update /); assert.match(staleRun.market, /^STALE · last update /);
assert.equal(staleRun.uptime, 'SNAPSHOT 18d 18h ago · STALE');
const mixed = await run(27021 * M, 10 * S);
assert.equal(mixed.mode, 'REAL MARKET DATA', 'a recent device sync keeps the label live');
console.log('Time labels: s/m/h/d formatting, 5-minute stale threshold and shipped app.js stale label checks passed.');
