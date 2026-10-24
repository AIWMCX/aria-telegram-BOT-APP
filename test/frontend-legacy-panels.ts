/**
 * Legacy engine panels vs hosted paper sniper. Loads the shipped scripts in a VM.
 * Run: npx tsx test/frontend-legacy-panels.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
class ClassList { values = new Set<string>(); add(...v: string[]) { v.forEach((x) => this.values.add(x)); } remove(...v: string[]) { v.forEach((x) => this.values.delete(x)); } }
class El {
  textContent = ""; value = ""; disabled = false; hidden = false; open = true; className = ""; classList = new ClassList(); style: Record<string, string> = {}; children: El[] = []; attributes = new Map<string, string>(); listeners = new Map<string, Function[]>(); colSpan = 0;
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes: unknown[]) { this.children.push(...nodes.filter((x): x is El => x instanceof El)); }
  appendChild(node: El) { this.children.push(node); return node; }
  removeChild(node: El) { this.children = this.children.filter((x) => x !== node); return node; }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  scrollIntoView() {}
}

// Static layout: sniper section precedes the founder test; legacy panels live inside the disclosure.
assert.ok(html.indexOf('id="paper-sniper"') < html.indexOf('id="founder-review"'), "paper sniper must be above the founder wallet test");
const detailsStart = html.indexOf('id="legacy-snapshot"'), detailsEnd = html.indexOf("</details>", detailsStart);
assert.ok(detailsStart > 0 && detailsEnd > detailsStart);
for (const id of ["session-summary", "s-detected", "pos-body", "f-bought"]) {
  const at = html.indexOf(`id="${id}"`);
  assert.ok(at > detailsStart && at < detailsEnd, `${id} must be inside the legacy disclosure`);
}
assert.ok(html.indexOf('id="status-card"') < detailsStart);
assert.ok(!/.innerHTMLs*=/.test(fs.readFileSync("public/paper-sniper.js", "utf8")));

async function run(sniperAvailable: boolean) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
  const elements = new Map(ids.map((id) => [id, new El()]));
  elements.get("paper-sniper")!.hidden = true;
  elements.get("legacy-summary")!.hidden = true;
  elements.get("status-sniper-note")!.hidden = true;
  const document = { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => new El(), execCommand: () => true, hidden: false };
  const initData = "user=%7B%22id%22%3A123%7D&auth_date=1&hash=test";
  const lastSeen = "2026-10-01T10:00:00.000Z";
  const fetch = async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, json: async () => body });
    if (url === "/api/product-reality") return ok({ ok: true, reality: { environment: "production", network: "solana-mainnet", dataMode: "live", executionMode: "paper", controlState: "stopped", paymentsEnabled: false } });
    if (url === "/api/engine/me") return ok({ ok: true, paired: true, device: { id: "dev", online: false, engineVersion: "0.7.0-beta.3", platform: "linux", lastSeenAt: lastSeen }, entitlement: { status: "active" }, snapshot: { receivedAt: lastSeen, data: { mode: "paper", openedCount: 5, closedCount: 0, rejectedCount: 0 } }, events: [], capabilities: {} });
    if (url === "/api/me") return ok({ ok: true, hasAccount: false, license: null });
    if (url === "/api/paper-sniper/status") return ok({ ok: true, enabled: true, available: sniperAvailable });
    if (url === "/api/paper-sniper/summary") return ok({ ok: true, snapshot: null, note: "No data yet." });
    throw new Error(`unexpected fetch ${url}`);
  };
  const context = vm.createContext({ console, document, AbortSignal, window: { Telegram: { WebApp: { ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, initData } }, innerHeight: 800 } as Record<string, unknown>, navigator: { clipboard: { writeText: async () => undefined } }, AbortController, setTimeout: () => 1, clearTimeout: () => undefined, setInterval: () => 1, fetch, Date });
  (context as any).window.document = document;
  for (const f of ["time-label.js", "app.js", "founder-review.js", "paper-sniper.js"]) vm.runInContext(fs.readFileSync(`public/${f}`, "utf8"), context, { filename: `public/${f}` });
  for (let i = 0; i < 60; i++) await Promise.resolve();
  return elements;
}

// Sniper NOT available: legacy behaviour unchanged.
{
  const e = await run(false);
  assert.equal(e.get("paper-sniper")!.hidden, true);
  assert.equal(e.get("legacy-snapshot")!.open, true);
  assert.equal(e.get("legacy-summary")!.hidden, true);
  assert.equal(e.get("status-sniper-note")!.hidden, true);
  assert.equal(e.get("status-engine")!.textContent, "STOPPED");
  assert.equal(e.get("status-version")!.textContent, "0.7.0-beta.3");
}

// Sniper available: legacy collapsed + labelled, engine shown as hosted paper sniper.
{
  const e = await run(true);
  assert.equal(e.get("paper-sniper")!.hidden, false);
  assert.equal(e.get("legacy-snapshot")!.open, false);
  assert.equal(e.get("legacy-summary")!.hidden, false);
  assert.equal(e.get("legacy-summary")!.textContent, "Legacy engine snapshot (not the paper sniper) — last update 2026-10-01 10:00:00 UTC");
  assert.equal(e.get("status-sniper-note")!.hidden, false);
  assert.match(html, /id="status-sniper-note" hidden>[^<]*Paper sniper section/);
  assert.equal(e.get("status-engine")!.textContent, "PAPER SNIPER (hosted)");
  // legacy numbers are still in the DOM (inside the closed disclosure), just not the headline
  assert.equal(e.get("s-detected")!.textContent, "5");
}
console.log("frontend legacy-panel / hosted paper sniper checks passed");
