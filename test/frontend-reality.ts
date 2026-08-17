import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("public/index.html", "utf8");

assert.ok(!html.includes(">LIVE<"), "initial HTML must not hard-code LIVE");
assert.ok(!html.includes("Live mainnet execution"), "access copy must not claim live mainnet execution");
assert.ok(!html.includes("Live Event Stream"), "generated feed must not be titled Live Event Stream");
assert.ok(html.includes('id="reality-banner"'), "initial HTML must expose a product reality banner");
assert.ok(html.includes('id="data-mode"'), "initial HTML must expose a data-mode target");
assert.ok(html.includes('id="execution-mode"'), "initial HTML must expose an execution-mode target");
assert.ok(
  html.includes("SIMULATED - NO REAL FUNDS") || html.includes("UNAVAILABLE - NO REAL FUNDS"),
  "generated operational UI must disclose that displayed activity is not real funds",
);

console.log("frontend reality static checks passed");
