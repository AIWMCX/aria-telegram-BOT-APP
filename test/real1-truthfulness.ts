import assert from "node:assert/strict";
import fs from "node:fs";

Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "1234567890:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
  PUBLIC_URL: "https://aria.example.test",
  RESEND_API_KEY: "re_test_truthfulness_key",
  ADMIN_EMAIL: "admin@example.test",
  FROM_EMAIL: "aria@example.test",
  ARIA_LICENSE_PRIVATE_D: "private-key-placeholder-for-test-only",
  ARIA_LICENSE_PUBLIC_X: "public-key-placeholder-for-test-only",
});

const { TIER_LIMITS } = await import("../src/config.js");

for (const [tier, limits] of Object.entries(TIER_LIMITS)) {
  const features: readonly string[] = limits.features;
  assert.equal(features.includes("live"), false, `${tier} must not issue unsupported live capability in REAL-1`);
  assert.equal(features.includes("jito_bundles"), false, `${tier} must not issue unsupported jito_bundles capability in REAL-1`);
}

const botSource = fs.readFileSync("src/bot.ts", "utf8");
const frontendSource = fs.readFileSync("public/index.html", "utf8");
const customerSource = `${botSource}\n${frontendSource}`.toLowerCase();

assert.match(botSource, /ARIA REAL-1 Terminal/);
assert.match(botSource, /Solana mainnet market data/);
assert.match(botSource, /Paper execution/);
assert.match(botSource, /No real orders/);
assert.match(botSource, /No custody/);
assert.doesNotMatch(customerSource, /live terminal/);
assert.doesNotMatch(customerSource, /live trading/);
assert.doesNotMatch(customerSource, /live mainnet execution/);

console.log("REAL-1 commercial truthfulness gate passed");
