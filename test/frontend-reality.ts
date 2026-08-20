import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
const appJs = fs.readFileSync("public/app.js", "utf8");
assert.equal(html.includes(">LIVE<"), false);
assert.equal(html.includes("Live mainnet execution"), false);
assert.equal(html.includes("Live Event Stream"), false);
assert.equal(html.includes("UNAVAILABLE - EXECUTION DISABLED - NO REAL FUNDS"), true);
assert.equal(appJs.includes("simulateDetection"), false);

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
const context = vm.createContext({ console, document, window: { Telegram: undefined, innerHeight: 800 }, navigator: { clipboard: { writeText: async () => undefined } }, AbortController, setTimeout: (fn: Function) => { timeoutQueue.push(fn); return timeoutQueue.length; }, clearTimeout: () => undefined, setInterval: () => 1, fetch: async (url: string) => { assert.equal(url, "/api/product-reality"); return { ok: true, json: async () => ({ ok: true, reality: { environment: "production", network: "offline", dataMode: "simulated", executionMode: "disabled", controlState: "stopped", paymentsEnabled: false } }) }; } });
vm.runInContext(appJs, context, { filename: "public/app.js" });
for (let i = 0; i < 10; i++) await Promise.resolve();
assert.equal(elements.get("data-mode")!.textContent, "SIMULATED");
assert.equal(elements.get("execution-mode")!.textContent, "EXECUTION DISABLED");
assert.equal(elements.get("feed-count")!.textContent, "0 events");
assert.equal(elements.get("engine-connection")!.textContent, "DISCONNECTED");
assert.equal(elements.get("engine-start-btn")!.disabled, true);
console.log("frontend shipped-JS reality checks passed");
