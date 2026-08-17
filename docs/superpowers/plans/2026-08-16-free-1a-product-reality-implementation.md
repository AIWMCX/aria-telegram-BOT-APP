# FREE-1A Product Reality Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a backend-owned product-reality contract and make the production Mini App fail closed so simulated or unavailable data can never appear as live trading activity.

**Architecture:** Add a pure `src/product-reality.ts` domain that parses operator intent, validates cross-field combinations and code-backed capabilities, and produces an immutable public `ProductReality`. `src/config.ts` resolves that state once at startup, `src/server.ts` exposes it read-only, and the shipped `public/index.html` + `public/app.js` render only from that state. Generated demo activity is started only after a validated `simulated` response; every failure path renders unavailable/disabled/stopped and never starts demo generators.

**Tech Stack:** Node.js >=22.13, TypeScript 5.7, Hono, Zod, plain browser JavaScript, Node `vm`/filesystem test harness, GitHub Actions, Railway Docker deployment.

## Global Constraints

- Preserve the current ARIA terminal visual identity; FREE-1A changes truth semantics, not the full shell/navigation.
- Production default is `production/offline/simulated/disabled/stopped` until real integrations exist.
- `LIVE DATA` is allowed only when a real backend live-data capability exists in code; an environment variable alone cannot create that capability.
- `PAPER`, `DEVNET`, or `MAINNET` execution is not enabled by this increment. Unsupported requested execution modes must fail startup rather than become a cosmetic claim.
- Missing reality configuration uses the safe baseline; malformed reality configuration degrades to `unavailable/disabled/stopped`.
- Valid-but-contradictory execution/network configuration fails startup.
- Browser state is presentation only and never authorization.
- No seed phrase, private key, signer credential, RPC secret, provider identifier, license token, or user object may appear in `/api/product-reality`.
- No database migration, custody change, reservation, deposit credit, withdrawal, or trade execution belongs in FREE-1A.
- Legacy licensing may remain operational, but pricing/license copy must not claim that it enables the future funded product.
- No new npm dependency for frontend testing; use Node built-ins and a deterministic fake DOM/timer harness.
- CI remains `npm ci -> npm run typecheck -> npm test`; exact-SHA deployment evidence is required before completion.
- Every code task follows red-green-refactor and ends in a focused commit.

---

## File Structure

**Create**
- `src/product-reality.ts` — public types, internal config parser, capability gates, cross-field validation, immutable resolver.
- `test/product-reality.ts` — pure unit tests for defaults, malformed values, unsupported capabilities, and contradictory valid states.
- `test/frontend-reality.ts` — executes the shipped `public/app.js` in a deterministic Node `vm` fake browser and verifies rendered truth state plus simulation gating.

**Modify**
- `src/config.ts` — resolve product reality once after `PAYMENTS_ENABLED` is known and export `PRODUCT_REALITY`.
- `src/server.ts` — add `GET /api/product-reality` returning only the sanitized immutable public object.
- `.env.example` — document the five optional reality variables and safe production values.
- `public/index.html` — remove hard-coded live/mainnet claims, add stable status/disclosure DOM targets, and make initial markup fail closed before JavaScript runs.
- `public/app.js` — fetch/validate reality state, render labels, gate demo generators, and render unavailable state on any API/shape failure.
- `public/styles.css` — minimal styles for the persistent reality banner and per-panel disclosure labels, reusing existing tokens.
- `test/e2e.ts` — endpoint contract and secret-exclusion checks.
- `package.json` — split backend/frontend/unit test scripts and make `npm test` run all three without adding dependencies.
- `README.md` — document the product-reality endpoint, defaults, and local validation commands.

## Stable Interfaces

```ts
export type ProductEnvironment = "production" | "staging" | "development";
export type NetworkMode = "offline" | "solana-devnet" | "solana-mainnet";
export type DataMode = "unavailable" | "simulated" | "live";
export type ExecutionMode = "disabled" | "paper" | "devnet" | "mainnet";
export type ControlState = "stopped" | "starting" | "running" | "stopping";

export interface ProductReality {
  environment: ProductEnvironment;
  network: NetworkMode;
  dataMode: DataMode;
  executionMode: ExecutionMode;
  controlState: ControlState;
  paymentsEnabled: boolean;
}

export interface ProductCapabilities {
  liveData: boolean;
  paperExecution: boolean;
  devnetExecution: boolean;
  mainnetExecution: boolean;
}

export interface ParsedProductRealityConfig {
  environment?: ProductEnvironment;
  network?: NetworkMode;
  dataMode?: DataMode;
  executionMode?: ExecutionMode;
  controlState?: ControlState;
  paymentsEnabled: boolean;
  malformed: boolean;
}

export function parseProductRealityConfig(
  env: NodeJS.ProcessEnv,
  paymentsEnabled: boolean,
): ParsedProductRealityConfig;

export function resolveProductReality(
  config: ParsedProductRealityConfig,
  capabilities?: ProductCapabilities,
): Readonly<ProductReality>;
```

The FREE-1A code-backed capability value is fixed to:

```ts
export const CURRENT_PRODUCT_CAPABILITIES: Readonly<ProductCapabilities> = Object.freeze({
  liveData: false,
  paperExecution: false,
  devnetExecution: false,
  mainnetExecution: false,
});
```

Environment variable names are fixed as:

```text
ARIA_PRODUCT_ENVIRONMENT
ARIA_NETWORK_MODE
ARIA_DATA_MODE
ARIA_EXECUTION_MODE
ARIA_CONTROL_STATE
```

---

### Task 1: Product-reality domain — fail-closed unit contract

**Files:**
- Create: `test/product-reality.ts`
- Create: `src/product-reality.ts`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv`, a boolean `paymentsEnabled`, and `ProductCapabilities`.
- Produces: the exact types/functions in **Stable Interfaces** above.

- [ ] **Step 1: Add the failing unit test file**

Create `test/product-reality.ts` with assertions for all owner-approved invariants. Use Node's built-in `assert/strict`; do not add a test framework.

```ts
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
```

- [ ] **Step 2: Run the unit test and observe the intended failure**

Run:

```bash
npx tsx test/product-reality.ts
```

Expected: FAIL because `src/product-reality.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure domain module**

Create `src/product-reality.ts`. Use exact enum sets rather than arbitrary JSON. Missing values remain `undefined`; malformed present values set `malformed: true`. When `malformed` is true, return the fail-closed public state while preserving only a valid environment value and `paymentsEnabled`.

Implementation rules:

```ts
const SAFE_BASELINE = {
  environment: "production",
  network: "offline",
  dataMode: "simulated",
  executionMode: "disabled",
  controlState: "stopped",
} as const;

const FAIL_CLOSED = {
  network: "offline",
  dataMode: "unavailable",
  executionMode: "disabled",
  controlState: "stopped",
} as const;
```

Use a small `readEnum()` helper that distinguishes **missing** from **present but invalid**. Apply validation in this order:

1. If `malformed`, return fail-closed.
2. Apply missing-value defaults.
3. Reject unsupported capability claims (`live`, `paper`, `devnet`, `mainnet`).
4. Reject `mainnet` execution unless network is `solana-mainnet`.
5. Reject `devnet` execution unless network is `solana-devnet`.
6. Reject `running` control while execution is `disabled`.
7. Return `Object.freeze(...)`.

Do not import `src/config.ts`; this module must stay pure and unit-testable.

- [ ] **Step 4: Run the unit test and typecheck**

```bash
npx tsx test/product-reality.ts
npm run typecheck
```

Expected: PASS, zero TypeScript errors.

- [ ] **Step 5: Commit the domain**

```bash
git add src/product-reality.ts test/product-reality.ts
git commit -m "feat: add fail-closed product reality domain"
```

---

### Task 2: Startup configuration and operator contract

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseProductRealityConfig(process.env, PAYMENTS_ENABLED)`.
- Produces: `export const PRODUCT_REALITY: Readonly<ProductReality>`.

- [ ] **Step 1: Extend the unit test to assert the documented production env values**

Add this case to `test/product-reality.ts`:

```ts
const documentedProduction = resolveProductReality(parseProductRealityConfig({
  ARIA_PRODUCT_ENVIRONMENT: "production",
  ARIA_NETWORK_MODE: "offline",
  ARIA_DATA_MODE: "simulated",
  ARIA_EXECUTION_MODE: "disabled",
  ARIA_CONTROL_STATE: "stopped",
}, false));
assert.equal(documentedProduction.dataMode, "simulated");
assert.equal(documentedProduction.executionMode, "disabled");
assert.equal(documentedProduction.controlState, "stopped");
```

- [ ] **Step 2: Run the focused test**

```bash
npx tsx test/product-reality.ts
```

Expected: PASS; this locks the env contract before wiring startup.

- [ ] **Step 3: Wire startup resolution in `src/config.ts`**

After `PAYMENTS_ENABLED` is computed, import the product-reality helpers and export one process-lifetime value:

```ts
export const PRODUCT_REALITY = resolveProductReality(
  parseProductRealityConfig(process.env, PAYMENTS_ENABLED),
);
```

Do not expose the raw reality env object elsewhere. A valid but impossible or unsupported claim must throw during module initialization so Railway marks the deployment unhealthy instead of serving a false mode.

- [ ] **Step 4: Document exact env values in `.env.example`**

Add:

```dotenv
# Product reality — presentation truth only. These values do NOT authorize funds/trades.
ARIA_PRODUCT_ENVIRONMENT=production
ARIA_NETWORK_MODE=offline
ARIA_DATA_MODE=simulated
ARIA_EXECUTION_MODE=disabled
ARIA_CONTROL_STATE=stopped
```

Include comments that `live`, `paper`, `devnet`, and `mainnet` are rejected until their corresponding code-backed capability exists.

- [ ] **Step 5: Make `npm test` own all test layers**

Change scripts to the following shape without adding dependencies:

```json
{
  "test:reality": "tsx test/product-reality.ts",
  "test:backend": "tsx test/e2e.ts",
  "test:frontend": "tsx test/frontend-reality.ts",
  "test": "npm run test:reality && npm run test:backend && npm run test:frontend"
}
```

At this task, `test:frontend` is allowed to fail because its file is created in Task 5; use `npm run test:reality` and `npm run test:backend` until then.

- [ ] **Step 6: Verify startup-safe layers**

```bash
npm run test:reality
npm run test:backend
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit configuration wiring**

```bash
git add src/config.ts .env.example package.json test/product-reality.ts
git commit -m "feat: wire product reality startup configuration"
```

---

### Task 3: Public backend endpoint and schema leakage guard

**Files:**
- Modify: `src/server.ts`
- Modify: `test/e2e.ts`

**Interfaces:**
- Consumes: `PRODUCT_REALITY` from `src/config.ts`.
- Produces: unauthenticated read-only `GET /api/product-reality`.

- [ ] **Step 1: Write the failing endpoint assertions in `test/e2e.ts`**

After the `/healthz` checks, add:

```ts
const rr = await app.request("/api/product-reality");
const realityBody = await rr.json() as {
  ok: boolean;
  reality: Record<string, unknown>;
};
check("/api/product-reality -> 200", rr.status === 200);
check("/api/product-reality returns safe production defaults",
  realityBody.ok === true &&
  realityBody.reality.environment === "production" &&
  realityBody.reality.network === "offline" &&
  realityBody.reality.dataMode === "simulated" &&
  realityBody.reality.executionMode === "disabled" &&
  realityBody.reality.controlState === "stopped" &&
  realityBody.reality.paymentsEnabled === false);

const realityJson = JSON.stringify(realityBody);
for (const forbidden of [
  "TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "ARIA_LICENSE_PRIVATE_D",
  "ARIA_LICENSE_PUBLIC_X",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "PUBLIC_URL",
]) {
  check(`/api/product-reality excludes ${forbidden}`, !realityJson.includes(forbidden));
}
```

- [ ] **Step 2: Run backend test and observe the intended 404 failure**

```bash
npm run test:backend
```

Expected: FAIL on the missing endpoint.

- [ ] **Step 3: Add the route in `src/server.ts`**

Import `PRODUCT_REALITY` with the existing config imports and add before authenticated routes:

```ts
app.get("/api/product-reality", (c) =>
  c.json({ ok: true, reality: PRODUCT_REALITY }),
);
```

No request-derived data, headers, cookies, user IDs, configuration object, or provider details belong in this response.

- [ ] **Step 4: Run focused verification**

```bash
npm run test:backend
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the endpoint**

```bash
git add src/server.ts test/e2e.ts
git commit -m "feat: expose sanitized product reality endpoint"
```

---

### Task 4: Fail-closed initial HTML and commercially truthful copy

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`

**Interfaces:**
- Produces stable DOM IDs consumed by Task 5:
  - `reality-banner`
  - `data-mode`
  - `network-mode`
  - `execution-mode`
  - `control-state`
  - repeated `[data-reality-label]` elements on generated-data panels.

- [ ] **Step 1: Add a static-source failing check to `test/frontend-reality.ts`**

Create the file initially with only static checks:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync("public/index.html", "utf8");
assert.ok(!html.includes(">LIVE<"), "initial HTML must not hard-code LIVE");
assert.ok(!html.includes("Live mainnet execution"), "pricing must not claim live mainnet execution");
assert.ok(!html.includes("Live Event Stream"), "generated feed must not be titled Live Event Stream");
assert.ok(html.includes('id="reality-banner"'));
assert.ok(html.includes('id="data-mode"'));
assert.ok(html.includes('id="execution-mode"'));
assert.ok(html.includes("SIMULATED - NO REAL FUNDS") || html.includes("UNAVAILABLE - NO REAL FUNDS"));

console.log("frontend reality static checks passed");
```

- [ ] **Step 2: Run it and observe the intended failure**

```bash
npx tsx test/frontend-reality.ts
```

Expected: FAIL because current HTML hard-codes `LIVE`, `Live Event Stream`, and `Live mainnet execution` and lacks the new status IDs.

- [ ] **Step 3: Make initial markup fail closed before JavaScript executes**

Change the topbar to default to no stronger than:

```html
<div class="center">
  <span><span class="pulse"></span><span id="data-mode">UNAVAILABLE</span></span>
  <span><span class="pulse"></span><span id="network-mode">OFFLINE</span></span>
</div>
<div class="right">
  <span class="clock" id="clock" aria-label="current time">--:--:--</span>
  <span class="chip demo" id="execution-mode">EXECUTION DISABLED</span>
  <span class="chip demo" id="control-state">STOPPED</span>
</div>
```

Add a visible banner immediately below the topbar:

```html
<div class="reality-banner" id="reality-banner" role="status" aria-live="polite">
  UNAVAILABLE - EXECUTION DISABLED - NO REAL FUNDS
</div>
```

For each generated-data panel — Operations, Open Positions, Filter Funnel, Event Stream — add a persistent `<span class="meta reality-label" data-reality-label>UNAVAILABLE - NO REAL FUNDS</span>` in its panel header.

Rename `Live Event Stream` to `Event Stream`. Remove `Live mainnet execution` from the free-plan feature list. Replace it with `Execution disabled until separately activated`. Replace any footer language that implies current live execution with: `This Mini App currently does not execute trades or hold funds. Any future execution capability will be separately enabled and explicitly disclosed.`

Do not remove the existing risk notice.

- [ ] **Step 4: Add minimal styling using existing design tokens**

Add `.reality-banner` and `.reality-label` rules that reuse existing background/border/text variables. The disclosure must be visible without hover, not hidden behind a tooltip, and readable at the Telegram mobile viewport.

- [ ] **Step 5: Run the static frontend checks**

```bash
npx tsx test/frontend-reality.ts
```

Expected: PASS for static checks.

- [ ] **Step 6: Commit fail-closed markup**

```bash
git add public/index.html public/styles.css test/frontend-reality.ts
git commit -m "fix: make initial terminal reality state fail closed"
```

---

### Task 5: Shipped frontend runtime — validated fetch, rendering, and demo gating

**Files:**
- Modify: `public/app.js`
- Expand: `test/frontend-reality.ts`

**Interfaces:**
- Consumes: `GET /api/product-reality` shape from Task 3 and DOM IDs from Task 4.
- Produces: runtime state no stronger than backend reality; simulation scheduler starts only for validated `dataMode: "simulated"`.

- [ ] **Step 1: Expand `test/frontend-reality.ts` with a deterministic fake browser**

Use `node:vm` and a minimal fake DOM. The harness must execute the actual `public/app.js` source, not copied handler logic. Implement these fake-element capabilities because the shipped script uses them: `textContent`, `className`, `classList.add/remove`, `style`, `value`, `disabled`, `children`, `firstChild`, `append`, `appendChild`, `removeChild`, `setAttribute`, `removeAttribute`, `addEventListener`, and `scrollIntoView`.

Read all IDs from `public/index.html` with:

```ts
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
```

Create one fake element per ID. Provide:

```ts
const document = {
  body: new FakeElement("body"),
  getElementById: (id: string) => elements.get(id) ?? null,
  createElement: (tag: string) => new FakeElement(tag),
};
```

Use a queued fake timer implementation. Do not auto-run timers during script evaluation. Expose a test helper `runQueuedTimers(limit = 20)` that executes at most `limit` scheduled callbacks so accidental recursive simulation cannot hang the test.

Stub Telegram as absent, clipboard as a no-op, and `fetch` as scenario-specific.

- [ ] **Step 2: Add failing runtime scenarios before changing `app.js`**

Add three scenarios:

1. **Simulated** — fetch resolves with `production/offline/simulated/disabled/stopped`; rendered topbar and every `[data-reality-label]` must contain simulation disclosure; after queued timers run, generated event count may increase.
2. **Unavailable** — fetch rejects; rendered state must be `UNAVAILABLE`, `EXECUTION DISABLED`, `STOPPED`; after queued timers run, `feed-count` remains `0 events`, `pos-body` remains empty/unavailable, and no PnL activity appears.
3. **Malformed response** — fetch returns `{ok:true,reality:{dataMode:"live"}}`; treat as unavailable rather than partially trusting it.

Also assert that disabled execution never renders the substring `MAINNET EXECUTION`.

- [ ] **Step 3: Run the shipped frontend test and observe failure**

```bash
npx tsx test/frontend-reality.ts
```

Expected: FAIL because current `public/app.js` starts simulation timers unconditionally and has no product-reality fetch/render path.

- [ ] **Step 4: Add a strict browser-side reality validator in `public/app.js`**

Define a constant safe fallback:

```js
const SAFE_REALITY = Object.freeze({
  environment: "production",
  network: "offline",
  dataMode: "unavailable",
  executionMode: "disabled",
  controlState: "stopped",
  paymentsEnabled: false,
});
```

Validate all six fields against exact enum arrays. Unknown/missing fields return `SAFE_REALITY`; do not merge partial responses.

- [ ] **Step 5: Add one renderer for all operational truth labels**

Implement `renderProductReality(reality)` that maps:

```text
dataMode unavailable -> UNAVAILABLE
simulated -> SIMULATED
a live response -> LIVE DATA
network offline -> OFFLINE
solana-devnet -> SOLANA DEVNET
solana-mainnet -> SOLANA MAINNET
execution disabled -> EXECUTION DISABLED
paper -> PAPER EXECUTION
devnet -> DEVNET EXECUTION
mainnet -> MAINNET EXECUTION
control state -> uppercase enum
```

For `simulated`, every `data-reality-label` must read `SIMULATED - NO REAL FUNDS` and the banner must read `SIMULATED - EXECUTION DISABLED - NO REAL FUNDS` for the current production state.

For `unavailable`, every generated block must read `UNAVAILABLE - NO REAL FUNDS` and the banner must read `UNAVAILABLE - EXECUTION DISABLED - NO REAL FUNDS`.

- [ ] **Step 6: Move all demo scheduler startup behind validated simulated state**

Keep the clock timer independent. Remove these unconditional startup lines from module scope:

```js
setTimeout(scheduleDetect, 800);
setInterval(simulatePositionTick, 1500);
```

Add an idempotent `startSimulation()` that starts them once, and call it only after a validated response with `dataMode === "simulated"`.

For `unavailable` and `live`, do not run generated-data timers. FREE-1A has no live provider, so current backend cannot validly return `live`; the frontend nevertheless must not substitute simulation if such a response is received.

- [ ] **Step 7: Add explicit empty/unavailable rendering**

Implement `renderGeneratedDataUnavailable()` that resets counts, clears positions/feed, sets PnL to `—`, and places a visible unavailable row/message. It must not fabricate zero as if zero were a measured live value when data is unavailable.

- [ ] **Step 8: Fetch the contract with a bounded timeout and fail closed**

At startup, call `/api/product-reality` before simulation startup. Use `AbortController` with a 4-second timeout. Any fetch rejection, abort, non-2xx status, non-JSON body, `{ok:false}`, or invalid shape renders `SAFE_REALITY` and unavailable generated-data state.

Do not block license restore/form wiring on this fetch; only operational/demo presentation is gated.

- [ ] **Step 9: Run frontend, unit, backend, and type checks**

```bash
npm run test:frontend
npm run test:reality
npm run test:backend
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit runtime truth gating**

```bash
git add public/app.js test/frontend-reality.ts
git commit -m "feat: gate terminal presentation on product reality"
```

---

### Task 6: Full suite, docs, and static contradiction scan

**Files:**
- Modify: `README.md`
- Modify: `test/frontend-reality.ts` if the final static scan needs adjustment.

**Interfaces:**
- Produces: documented operator workflow and regression coverage for misleading claims.

- [ ] **Step 1: Add final static contradiction assertions**

The frontend test must read the shipped HTML and assert the production source does not contain these current misleading literals:

```text
>LIVE<
Live Event Stream
Live mainnet execution
```

Do not ban the string `live` globally because the validated runtime mapping needs `LIVE DATA` for future real capability.

- [ ] **Step 2: Update `README.md`**

Document:

```text
GET /api/product-reality
Default production: production/offline/simulated/disabled/stopped
Malformed reality env: unavailable/disabled/stopped
Unsupported or contradictory execution claim: startup failure
```

Add local verification commands:

```bash
npm ci
npm run typecheck
npm test
npm run dev
curl -s http://localhost:8080/api/product-reality
```

State explicitly that these flags are presentation truth and do not authorize financial actions.

- [ ] **Step 3: Run the full repository gates**

```bash
npm ci
npm run typecheck
npm test
```

Expected: zero type errors and all test scripts pass.

- [ ] **Step 4: Inspect the final diff for scope and secrets**

```bash
git diff main...HEAD -- . ':!package-lock.json'
git diff --check main...HEAD
git grep -nE '(sk_live_|sk_test_|re_[A-Za-z0-9]{16,}|[0-9]{8,}:[A-Za-z0-9_-]{20,})' -- ':!.env.example'
```

Expected: no whitespace errors and no real credential material.

- [ ] **Step 5: Commit docs if changed**

```bash
git add README.md test/frontend-reality.ts
git commit -m "docs: document product reality operating contract"
```

---

### Task 7: Branch-level CI and review gate

**Files:**
- No application file changes unless review finds a defect.

**Interfaces:**
- Produces: exact branch SHA with green CI and review evidence.

- [ ] **Step 1: Record exact branch SHA**

```bash
git rev-parse HEAD
```

Copy the full SHA into the execution notes.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin codex/free-1a-product-reality-design
```

- [ ] **Step 3: Open or update the FREE-1A pull request**

PR title:

```text
FREE-1A: make product reality fail closed
```

PR body must list: contract endpoint, backend capability gates, hard-coded copy removal, simulation gating, test layers, zero financial mutation, and the exact SHA under review.

- [ ] **Step 4: Wait for GitHub Actions on that exact SHA and inspect every job**

Acceptance: `npm ci`, `npm run typecheck`, and `npm test` are green for the same SHA. A green run for an older SHA is not evidence.

- [ ] **Step 5: Perform independent review focused on trust claims**

Reviewer questions:

```text
Can any malformed/missing response render LIVE or MAINNET?
Can demo generators start after failed reality retrieval?
Can an env var claim a capability that code does not implement?
Does the endpoint disclose any secret/provider/user data?
Does any shipped static copy still imply real current trading?
Did FREE-1A introduce any financial mutation or authorization path?
```

Any P0/P1 answer blocks merge.

---

### Task 8: Merge and exact-SHA Railway promotion evidence

**Files:**
- No new code by default.

**Interfaces:**
- Produces: one exact merged/deployed SHA satisfying all FREE-1A acceptance criteria.

- [ ] **Step 1: Merge only after branch CI and review are clean**

Use the repository's normal squash/merge policy. Record the resulting `main` SHA.

- [ ] **Step 2: Verify Railway deploys the exact merge SHA**

Do not treat a generic `Deployment successful` message as sufficient. The deployment metadata/logs must identify the same merge SHA.

- [ ] **Step 3: Verify production health**

Request:

```text
GET /healthz
GET /api/product-reality
```

Required production reality:

```json
{
  "environment": "production",
  "network": "offline",
  "dataMode": "simulated",
  "executionMode": "disabled",
  "controlState": "stopped"
}
```

`paymentsEnabled` may reflect the actual existing Stripe configuration but remains informational only.

- [ ] **Step 4: Verify the shipped production UI**

Required evidence:

```text
No hard-coded LIVE status before API load.
Topbar says SIMULATED / OFFLINE / EXECUTION DISABLED / STOPPED.
Every generated operational panel says SIMULATED - NO REAL FUNDS.
No Live Event Stream heading.
No Live mainnet execution sales claim.
Failed reality fetch degrades to UNAVAILABLE and generated activity does not start.
```

Prefer real Telegram Mini App evidence. If Telegram client access is unavailable to the executing agent, mark this gate `BLOCKED: Telegram client evidence unavailable`; do not substitute a reconstructed event handler and call it production proof.

- [ ] **Step 5: Capture rollback reference**

Record the immediately preceding production SHA. Rollback requires disabling the Mini App or equivalent maintenance behavior if that preceding version reintroduces misleading live claims.

- [ ] **Step 6: Declare FREE-1A complete only when all evidence refers to one deployed SHA**

Completion evidence must include:

```text
merged SHA
GitHub Actions run for SHA
Railway deployment for SHA
/healthz result
/api/product-reality result
production UI evidence or explicit Telegram-blocked status
secret/scope diff review result
```

---

## Self-Review Results

### Spec coverage

- Backend-owned typed reality model: Tasks 1-3.
- Fail-closed malformed/missing behavior: Tasks 1, 2, 5.
- Cross-field network/execution validation: Task 1.
- Code-backed capability requirement for `live`/execution: Task 1.
- Sanitized unauthenticated endpoint: Task 3.
- Initial HTML cannot flash a stronger state: Task 4.
- Persistent simulation disclosure on every generated block: Tasks 4-5.
- Failed fetch prevents generators: Task 5.
- Tests execute shipped frontend source: Task 5.
- Commercial truthfulness/no current live-mainnet claim: Tasks 4 and 6.
- No financial mutation/auth expansion: global constraints + review gate.
- Exact-SHA CI/Railway/runtime evidence: Tasks 7-8.
- Telegram-context evidence or explicit block: Task 8.

### Placeholder scan

No `TBD`, `TODO`, `implement later`, or unspecified test steps remain in this plan.

### Type/interface consistency

`ProductReality`, `ProductCapabilities`, `ParsedProductRealityConfig`, `parseProductRealityConfig()`, and `resolveProductReality()` are defined once under Stable Interfaces and referenced consistently by later tasks.

## Program Continuation After FREE-1A

FREE-1A must finish before implementation begins on the next vertical increment. The next design specifications, in order, are:

1. `FREE-1B` — Telegram identity/users domain, account status, disabled-user enforcement, cross-account authorization matrix, Postgres production verification.
2. `FREE-1C` — production Mini App shell, authenticated account/settings surface, risk acknowledgement/versioning, navigation and recovery UX.
3. `FREE-1D` — read-only Solana public-address connection, RPC provider abstraction, truthful balances, stale-data behavior, no signing.
4. `FREE-2A` — double-entry ledger domain and reconciliation invariants.
5. `FREE-2B` — devnet deposit observation, confirmation policy, exactly-once crediting, reorg/replay handling.
6. `FREE-2C` — reconciliation service, incident states, operator repair controls, audit evidence.
7. `FREE-3A` — withdrawal intent/reservation/idempotency domain.
8. `FREE-3B` — signer boundary, policy engine, devnet withdrawal execution and recovery.
9. `FREE-4A` — market-data/execution adapter contracts and paper execution.
10. `FREE-4B` — positions, realized/unrealized PnL, strategy state, deterministic accounting.
11. `FREE-4C` — user STOP, global halt, circuit breakers, recovery and operator controls.
12. `FREE-4D` — devnet execution integration, reconciliation and failure injection.
13. `FREE-5` — minimal mainnet closed beta with capital/rate limits, allowlist, incident runbook and audit gates.
14. `FREE-6` — external-user validation, support readiness, abuse/fraud monitoring, production certification.
15. `MON-1A` — commercial model and unit economics after retention/safety evidence: pricing hypothesis, cost-to-serve, support burden, payment rails, refund policy and margin floors.
16. `MON-1B` — packaging/entitlements that do not weaken risk controls or custody boundaries.
17. `MON-1C` — conversion, billing lifecycle, tax/legal/geo constraints, churn/refund handling and commercial telemetry.

Each increment follows the same gate: **design spec -> owner approval -> TDD implementation plan -> implementation -> independent review -> exact-SHA CI -> exact-SHA deployment -> runtime evidence -> completion declaration**.
