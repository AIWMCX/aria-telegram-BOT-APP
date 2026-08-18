import assert from "node:assert/strict";
import {
  CURRENT_PRODUCT_CAPABILITIES,
  parseProductRealityConfig,
  resolveProductReality,
} from "../src/product-reality.js";

const defaults = resolveProductReality(parseProductRealityConfig({}, false));
assert.deepEqual(defaults, {
  environment: "production",
  network: "offline",
  dataMode: "simulated",
  executionMode: "disabled",
  controlState: "stopped",
  paymentsEnabled: false,
});

const malformed = resolveProductReality(parseProductRealityConfig({
  ARIA_PRODUCT_ENVIRONMENT: "production",
  ARIA_NETWORK_MODE: "definitely-mainnet",
  ARIA_DATA_MODE: "live-ish",
  ARIA_EXECUTION_MODE: "turbo",
  ARIA_CONTROL_STATE: "running-fast",
}, true));
assert.deepEqual(malformed, {
  environment: "production",
  network: "offline",
  dataMode: "unavailable",
  executionMode: "disabled",
  controlState: "stopped",
  paymentsEnabled: true,
});

assert.throws(() => resolveProductReality(parseProductRealityConfig({
  ARIA_NETWORK_MODE: "offline",
  ARIA_EXECUTION_MODE: "mainnet",
}, false), { ...CURRENT_PRODUCT_CAPABILITIES, mainnetExecution: true }), /mainnet.*solana-mainnet/i);

assert.throws(() => resolveProductReality(parseProductRealityConfig({
  ARIA_NETWORK_MODE: "solana-mainnet",
  ARIA_EXECUTION_MODE: "devnet",
}, false), { ...CURRENT_PRODUCT_CAPABILITIES, devnetExecution: true }), /devnet.*solana-devnet/i);

assert.throws(() => resolveProductReality(parseProductRealityConfig({
  ARIA_EXECUTION_MODE: "disabled",
  ARIA_CONTROL_STATE: "running",
}, false)), /running.*disabled/i);

assert.throws(() => resolveProductReality(parseProductRealityConfig({
  ARIA_DATA_MODE: "live",
}, false)), /live data.*not implemented/i);

assert.throws(() => resolveProductReality(parseProductRealityConfig({
  ARIA_EXECUTION_MODE: "paper",
}, false)), /paper execution.*not implemented/i);

console.log("product-reality unit tests passed");
