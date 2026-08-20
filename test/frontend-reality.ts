import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
const appJs = fs.readFileSync("public/app.js", "utf8");
assert.equal(html.includes("Live mainnet execution"), false);
assert.equal(html.includes("REAL-1 · PAPER ONLY · NO REAL ORDERS"), true);
assert.equal(html.includes("Real read-only Solana market data"), true);
assert.equal(appJs.includes("simulateDetection"), false);
assert.equal(appJs.includes("/api/engine/dashboard"), false);
assert.equal(appJs.includes("/api/engine/devices"), false);
assert.equal(appJs.includes("/api/engine/commands"), false);
assert.equal(appJs.includes("/api/engine/me"), true);
assert.equal(appJs.includes("/api/engine/command"), true);

class ClassList { values = new Set<string>(); add(...v: string[]) { v.forEach((x) => this.values.add(x)); } remove(...v: string[]) { v.forEach((x) => this.values.delete(x)); } }
class El {
  textContent = ""; value = ""; disabled = false; className = ""; classList = new ClassList(); style: Record<string, string> = {}; children: El[] = []; attributes = new Map<string, string>(); listeners = new Map<string, Function[]>(); colSpan = 0;
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes: unknown[]) { this.children.push(...nodes.filter((x): x is El => x instanceof El)); }
  appendChild(node: El) { this.children.push(node); return node; }
  removeChild(node: El) { this.children = this.children.filter((x) => x !== node); return node; }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  scrollIntoView() {}
}
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
const elements = new Map(ids.map((id) => [id, new El()]));
const document = { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => new El(), execCommand: () => true };
const timeoutQueue: Function[] = [];
const initData = "user=%7B%22id%22%3A123%7D&auth_date=1&hash=test";
const requests: Array<{ url: string; method: string }> = [];
const fetch = async (url: string, options: any = {}) => {
  requests.push({ url, method: options.method ?? "GET" });
  if (url === "/api/product-reality") return { ok: true, json: async () => ({ ok: true, reality: { environment: "production", network: "solana-mainnet", dataMode: "live", executionMode: "paper", controlState: "running", paymentsEnabled: false } }) };
  if (url === "/api/engine/me") return { ok: true, json: async () => ({ ok: true, paired: true, device: { id: "dev", online: true, engineVersion: "0.7.0-beta.1", platform: "darwin", lastSeenAt: new Date().toISOString() }, entitlement: { status: "active", expiresAt: new Date(Date.now() + 86400000).toISOString() }, snapshot: { receivedAt: new Date().toISOString(), data: { mode: "paper", openPositionCount: 2, openExposureLamports: "10000000", realizedPnlLamports: "890000", unrealizedPnlLamports: "125000", totalPaperFeesLamports: "100000", openedCount: 7, closedCount: 5, rejectedCount: 31 } }, events: [{ id: "e1", type: "paper-position-opened", occurredAt: new Date().toISOString(), data: {} }], capabilities: { paperPause: true, paperStop: true, requestSnapshot: true, remoteColdStart: false } }) };
  if (url === "/api/me") return { ok: true, json: async () => ({ ok: true, hasAccount: false, license: null }) };
  throw new Error(`unexpected fetch ${url}`);
};
const context = vm.createContext({ console, document, window: { Telegram: { WebApp: { ready() {}, expand() {}, setHeaderColor() {}, setBackgroundColor() {}, initData } }, innerHeight: 800 }, navigator: { clipboard: { writeText: async () => undefined } }, AbortController, setTimeout: (fn: Function) => { timeoutQueue.push(fn); return timeoutQueue.length; }, clearTimeout: () => undefined, setInterval: () => 1, fetch, Date });
vm.runInContext(appJs, context, { filename: "public/app.js" });
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(requests.some((r) => r.url === "/api/engine/me"), true);
assert.equal(elements.get("engine-connection")!.textContent, "CONNECTED");
assert.equal(elements.get("s-detected")!.textContent, "7");
assert.equal(elements.get("s-traded")!.textContent, "5 · 31");
assert.equal(elements.get("f-queued")!.textContent, "10000000");
assert.equal(elements.get("feed-count")!.textContent, "1 events");
assert.equal(elements.get("engine-start-btn")!.disabled, true);
assert.equal(elements.get("engine-pause-btn")!.disabled, false);
assert.equal(elements.get("engine-stop-btn")!.disabled, false);
console.log("frontend shipped-JS REAL-1 preview checks passed");
