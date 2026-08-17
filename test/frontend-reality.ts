import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
const appJs = fs.readFileSync("public/app.js", "utf8");

assert.ok(!html.includes(">LIVE<"), "initial HTML must not hard-code LIVE");
assert.ok(!html.includes("Live mainnet execution"), "access copy must not claim live mainnet execution");
assert.ok(!html.includes("Live Event Stream"), "generated feed must not be titled Live Event Stream");
assert.ok(html.includes('id="reality-banner"'), "initial HTML must expose a product reality banner");
assert.ok(html.includes('id="data-mode"'), "initial HTML must expose a data-mode target");
assert.ok(html.includes('id="execution-mode"'), "initial HTML must expose an execution-mode target");
assert.ok(html.includes("UNAVAILABLE - NO REAL FUNDS"), "initial generated-data UI must fail closed");

class FakeClassList {
  private values = new Set<string>();
  add(...names: string[]) { for (const name of names) this.values.add(name); }
  remove(...names: string[]) { for (const name of names) this.values.delete(name); }
  contains(name: string) { return this.values.has(name); }
}

class FakeElement {
  textContent = "";
  className = "";
  classList = new FakeClassList();
  style: Record<string, string> = {};
  value = "";
  disabled = false;
  title = "";
  colSpan = 0;
  scrollTop = 0;
  scrollHeight = 0;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Function[]>();

  get firstChild() { return this.children[0] ?? null; }
  append(...children: any[]) { for (const child of children) if (child instanceof FakeElement) this.children.push(child); }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  removeChild(child: FakeElement) { this.children = this.children.filter((x) => x !== child); return child; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, fn: Function) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  scrollIntoView() {}
  select() {}
  getBoundingClientRect() { return { top: 0 }; }
}

type RealityResponse =
  | { kind: "ok"; body: unknown }
  | { kind: "reject" };

async function runScenario(response: RealityResponse) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, new FakeElement());

  const labelCount = [...html.matchAll(/data-reality-label/g)].length;
  const labels = Array.from({ length: labelCount }, () => new FakeElement());
  const timeoutQueue: Function[] = [];
  const intervalQueue: Function[] = [];

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === "[data-reality-label]" ? labels : [],
    createElement: () => new FakeElement(),
    execCommand: () => true,
  };

  const fetch = async (url: string) => {
    assert.equal(url, "/api/product-reality", "non-Telegram startup should only fetch product reality");
    if (response.kind === "reject") throw new Error("network down");
    return {
      ok: true,
      json: async () => response.body,
    };
  };

  const context = vm.createContext({
    console,
    document,
    window: { Telegram: undefined, innerHeight: 800, location: { href: "" } },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch,
    AbortController,
    Date,
    Math,
    JSON,
    URLSearchParams,
    setTimeout: (fn: Function) => { timeoutQueue.push(fn); return timeoutQueue.length; },
    clearTimeout: () => undefined,
    setInterval: (fn: Function) => { intervalQueue.push(fn); return intervalQueue.length; },
    clearInterval: () => undefined,
  });

  vm.runInContext(appJs, context, { filename: "public/app.js" });
  for (let i = 0; i < 8; i++) await Promise.resolve();

  return {
    elements,
    labels,
    timeoutQueue,
    intervalQueue,
    runQueuedTimeouts(limit = 20) {
      let ran = 0;
      while (timeoutQueue.length && ran < limit) {
        const fn = timeoutQueue.shift()!;
        fn();
        ran++;
      }
      return ran;
    },
  };
}

const simulated = await runScenario({
  kind: "ok",
  body: {
    ok: true,
    reality: {
      environment: "production",
      network: "offline",
      dataMode: "simulated",
      executionMode: "disabled",
      controlState: "stopped",
      paymentsEnabled: false,
    },
  },
});
assert.equal(simulated.elements.get("data-mode")!.textContent, "SIMULATED");
assert.equal(simulated.elements.get("network-mode")!.textContent, "OFFLINE");
assert.equal(simulated.elements.get("execution-mode")!.textContent, "EXECUTION DISABLED");
assert.equal(simulated.elements.get("control-state")!.textContent, "STOPPED");
assert.ok(simulated.elements.get("reality-banner")!.textContent.includes("SIMULATED - NO REAL FUNDS"));
assert.ok(simulated.labels.every((x) => x.textContent === "SIMULATED - NO REAL FUNDS"));
assert.ok(simulated.timeoutQueue.length > 0, "simulated mode should schedule synthetic activity");
simulated.runQueuedTimeouts(4);
assert.notEqual(simulated.elements.get("feed-count")!.textContent, "0 events", "simulated mode may generate labeled events");

const unavailable = await runScenario({ kind: "reject" });
assert.equal(unavailable.elements.get("data-mode")!.textContent, "UNAVAILABLE");
assert.equal(unavailable.elements.get("execution-mode")!.textContent, "EXECUTION DISABLED");
assert.equal(unavailable.elements.get("control-state")!.textContent, "STOPPED");
assert.equal(unavailable.elements.get("feed-count")!.textContent, "0 events");
assert.equal(unavailable.elements.get("s-pnl")!.textContent, "—");
assert.ok(unavailable.labels.every((x) => x.textContent === "UNAVAILABLE - NO REAL FUNDS"));

const malformed = await runScenario({
  kind: "ok",
  body: { ok: true, reality: { dataMode: "live" } },
});
assert.equal(malformed.elements.get("data-mode")!.textContent, "UNAVAILABLE", "partial/malformed state must fail closed");
assert.equal(malformed.elements.get("execution-mode")!.textContent, "EXECUTION DISABLED");
assert.ok(!malformed.elements.get("reality-banner")!.textContent.includes("MAINNET EXECUTION"));
assert.equal(malformed.elements.get("feed-count")!.textContent, "0 events");

console.log("frontend reality runtime checks passed");
