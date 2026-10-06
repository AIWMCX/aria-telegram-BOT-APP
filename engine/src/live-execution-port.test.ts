import assert from "node:assert/strict";
import test from "node:test";
import { HummingbotGatewayExecutionAdapter, type GatewayReadinessProbe } from "./live-execution-port.js";

test("Gateway adapter accepts only HTTPS loopback endpoints", () => {
  const probe: GatewayReadinessProbe = { async readiness() { return { reachable: true, upstream: "gateway", version: "2.16.0" }; } };
  assert.throws(() => new HummingbotGatewayExecutionAdapter("http://127.0.0.1:15888", probe), /HTTPS loopback/);
  assert.throws(() => new HummingbotGatewayExecutionAdapter("https://gateway.example:15888", probe), /HTTPS loopback/);
  assert.doesNotThrow(() => new HummingbotGatewayExecutionAdapter("https://127.0.0.1:15888", probe));
});

test("Gateway adapter exposes readiness only and never transmits wallet or transaction material", async () => {
  const seen: URL[] = [];
  const probe: GatewayReadinessProbe = {
    async readiness(endpoint) {
      seen.push(endpoint);
      return { reachable: true, upstream: "gateway", version: "2.16.0" };
    },
  };
  const adapter = new HummingbotGatewayExecutionAdapter("https://localhost:15888", probe);
  assert.deepEqual(await adapter.health(), { status: "healthy", upstream: "hummingbot-gateway", version: "2.16.0" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.hostname, "localhost");
  assert.equal(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).some((name) => /quote|build|execute|sign|send|transaction/i.test(name)), false);
});
