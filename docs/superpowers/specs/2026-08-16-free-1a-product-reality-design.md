# FREE-1A Product Reality Contract Design

**Status:** Owner-approved design, pending implementation plan  
**Phase:** FREE-1 - Real Telegram account and application shell  
**Bounded increment:** FREE-1A - truthful product-state presentation  
**Accepted architecture:** `docs/ARIA_FUNDS_ARCHITECTURE_V1.md` v1.1 (`DELEGATED_VENDOR`)  
**Design baseline:** `main` at `f36b6c788cf8050ae48ec0e7700269b4d5d2a388`

## 1. Objective

Make the shipped Mini App fail closed about whether its data and execution are real. No simulated position, event, PnL, connectivity, or execution state may be presented as live. Preserve the established ARIA terminal visual language while replacing ambiguous claims with a backend-owned product-reality contract.

This increment does not create a Telegram `users` domain, connect a wallet, move funds, or execute trades. Those remain separate reviewable increments.

## 2. User outcome

When a user opens ARIA, the header and every operational block state exactly what is active:

- `SIMULATED` for generated demonstration data;
- `UNAVAILABLE` when data truth cannot be established;
- `LIVE DATA` only when the backend has a configured live data provider;
- `EXECUTION DISABLED`, `PAPER`, `DEVNET`, or `MAINNET` from backend state;
- `STOPPED`, `STARTING`, `RUNNING`, or `STOPPING` from backend control state.

The current deployment must resolve to simulated data, disabled execution, and stopped control. It must not display `LIVE`, `LIVE MAINNET EXECUTION`, or unqualified positions/PnL.

## 3. Approaches considered

### A. Backend-owned reality contract with existing UI - selected

Add a typed server-owned state contract and make the shipped UI render only from it. This creates one auditable trust boundary, preserves the recognizable interface, and supports later phases without another presentation rewrite.

### B. Frontend-only copy correction - rejected

Changing labels in `public/app.js` would address today's screenshots but would leave the frontend able to claim a stronger mode than the backend. It would not establish an invariant for future RPC, wallet, or execution integrations.

### C. Full shell redesign - deferred

A redesign could improve navigation but expands scope before identity and real account state exist. FREE-1A changes truth semantics only; FREE-1C owns navigation and shell restructuring.

## 4. Architecture

### 4.1 Product-reality domain

Create a small backend module that owns the public reality model:

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
```

`resolveProductReality(config)` returns a complete value. It never infers live capability from cosmetic frontend state, HTTP reachability, Railway deployment success, or a non-empty RPC URL.

### 4.2 Fail-closed invariants

The resolver enforces these combinations:

1. Missing, malformed, or contradictory configuration resolves to `dataMode: "unavailable"`, `executionMode: "disabled"`, and `controlState: "stopped"`.
2. `executionMode: "mainnet"` requires `network: "solana-mainnet"`; otherwise startup validation rejects the configuration.
3. `executionMode: "devnet"` requires `network: "solana-devnet"`; otherwise startup validation rejects the configuration.
4. `controlState: "running"` is invalid while execution is `disabled`.
5. `dataMode: "live"` means only that an implemented backend data integration is active. It does not mean trading is active.
6. Payments state remains informational and cannot grant access to the future free product.

No environment variable may directly inject an arbitrary JSON response. Configuration is parsed through enumerated values and validation.

### 4.3 Public API

Add an unauthenticated read-only endpoint:

```http
GET /api/product-reality
```

Successful response:

```json
{
  "ok": true,
  "reality": {
    "environment": "production",
    "network": "offline",
    "dataMode": "simulated",
    "executionMode": "disabled",
    "controlState": "stopped",
    "paymentsEnabled": false
  }
}
```

The response contains no secrets, provider identifiers, RPC URLs, internal policy references, account identifiers, or user information. It is not an authorization source for financial actions; future financial handlers must enforce their own server-side controls.

### 4.4 Frontend rendering

`public/app.js` fetches `/api/product-reality` during initialization before presenting operational claims. A single rendering function maps the validated response to labels and block visibility.

If the request fails, times out, returns non-JSON, or violates the contract, the frontend renders:

- `UNAVAILABLE` data status;
- `EXECUTION DISABLED`;
- `STOPPED`;
- no generated positions, PnL, purchase counts, or event stream.

For `dataMode: "simulated"`, generated dashboard blocks may remain for demonstration, but each relevant block receives a persistent, visible `SIMULATED - NO REAL FUNDS` label. The word `LIVE` is absent. `Bought`, `Sold`, `Open positions`, and PnL are prefixed or grouped under the simulation label so they cannot be interpreted as account activity.

For `dataMode: "unavailable"`, simulated generators do not start and operational metrics display an explicit unavailable/empty state.

The existing terminal typography, color system, compact layout, and Telegram-safe viewport behavior remain unchanged in this increment.

## 5. Components and responsibilities

- `src/product-reality.ts`: types, parsing, cross-field validation, fail-closed resolution, and public-response construction.
- `src/config.ts`: declare only the exact enumerated configuration consumed by the resolver; secrets remain outside the public model.
- `src/server.ts`: expose the read-only endpoint using the resolver output.
- `public/app.js`: fetch, validate defensively, and render the state; gate existing demo generators.
- `public/index.html`: provide stable DOM targets and permanent simulation/unavailable disclosures.
- `test/e2e.ts`: backend contract, invalid-combination, fail-closed, and endpoint tests.
- A frontend behavior test file or deterministic DOM harness, selected in the implementation plan after confirming the repository's dependency policy, to execute the shipped `public/app.js` behavior rather than recreate its handlers.

## 6. Data flow and trust boundaries

1. Railway supplies non-secret enumerated configuration.
2. Backend config parsing validates individual values.
3. `resolveProductReality` validates cross-field combinations.
4. `/api/product-reality` publishes the sanitized immutable result.
5. The shipped Mini App validates the received shape and renders a mode that is no stronger than the backend response.
6. Any network, parsing, or validation failure downgrades the UI to unavailable/disabled/stopped.

The browser is untrusted. Altering DOM state or API responses in a client does not enable execution because this increment does not add execution, and future execution authorization remains server-side.

## 7. Error handling

- Invalid deployment configuration fails startup when it claims an impossible execution/network combination.
- Missing optional reality configuration uses the safe production baseline: offline, simulated, disabled, stopped.
- API serialization failure returns a generic 500 response without configuration detail.
- Frontend fetch failure produces a visible degraded state and prevents demo timers/generators from starting.
- Unknown enum members are rejected by the frontend and handled as unavailable.
- No error path falls back to live, mainnet, or running.

## 8. Testing strategy

Implementation uses red-green-refactor.

### Backend tests

- Default configuration resolves to `offline/simulated/disabled/stopped`.
- Malformed values do not produce a stronger public state.
- Mainnet execution with any non-mainnet network is rejected.
- Devnet execution with any non-devnet network is rejected.
- Running control with disabled execution is rejected.
- `GET /api/product-reality` returns the exact sanitized schema and no secret-bearing configuration.

### Shipped frontend tests

- Simulated mode contains a persistent `SIMULATED - NO REAL FUNDS` disclosure and contains no standalone `LIVE` claim.
- Unavailable mode does not start or render generated positions, PnL, purchase counts, or events.
- A failed or malformed API response renders unavailable/disabled/stopped.
- Execution-disabled mode cannot render mainnet execution language.
- Tests execute the actual shipped JavaScript and DOM targets.

### Promotion evidence

- Observe the intended failing test before implementation.
- Run targeted tests and the complete repository suite.
- Poll GitHub Actions for the exact branch SHA.
- Inspect the final diff for secret exposure and misleading claims.
- After approved merge, poll Railway for the exact merge SHA.
- Request `/healthz` and `/api/product-reality` in production.
- Exercise the production bundle in the available Telegram Mini App context; if Telegram client access is unavailable, report that gate as blocked rather than substituting a reconstructed handler.

## 9. Security and financial invariants

- No simulated balance, position, trade, PnL, or event is displayed as real.
- No seed phrase, private key, signing capability, RPC credential, or vendor reference enters this contract.
- The endpoint is read-only and contains no user-owned object reference.
- No code in this increment moves, reserves, credits, or withdraws funds.
- No code enables paper, devnet, or mainnet execution.
- Client state is never treated as authorization.
- The previously retired order-license lookup remains retired.

## 10. Rollout and rollback

This increment has no database migration and no funds impact.

Rollout:

1. Deploy the exact merged SHA through the existing Railway integration.
2. Confirm Railway deployment success and production `/healthz`.
3. Confirm `/api/product-reality` reports production plus offline/simulated/disabled/stopped.
4. Confirm the shipped UI visibly discloses simulation and contains no contradictory live/mainnet execution claim.

Rollback is a code redeploy to the immediately preceding SHA. Because the preceding UI contains misleading `LIVE` language, rollback is acceptable only as a short incident measure with the Mini App disabled or an equivalent server-side maintenance response. No schema rollback is required.

## 11. Acceptance criteria

FREE-1A is complete only when all conditions hold for one exact deployed SHA:

1. The backend owns and publishes a validated product-reality contract.
2. Production reports `offline/simulated/disabled/stopped` until real integrations exist.
3. Every generated operational block is permanently labeled `SIMULATED - NO REAL FUNDS`.
4. Failed state retrieval displays unavailable/disabled/stopped and no generated activity.
5. The production UI contains no contradictory `LIVE` or live-mainnet execution claim.
6. Targeted tests, full tests, typecheck, exact-SHA CI, Railway deployment, health, and runtime endpoint checks pass.
7. Telegram-context evidence is captured or explicitly reported blocked.
8. No P0/P1 regression, secret exposure, financial mutation, or authorization expansion is introduced.

## 12. Explicitly deferred

- `users` table and Telegram account creation/restore: FREE-1B.
- Disabled-user enforcement and cross-account authorization matrix: FREE-1B.
- Full application navigation, settings, and risk acknowledgement: FREE-1C.
- Public-address wallet connection and real read-only balances: FREE-1D.
- Signer vendor integration and wallet authority: later approved vendor increment.
- Deposit observation, ledger crediting, and reconciliation: FREE-2.
- Withdrawals: FREE-3.
- Execution, positions, PnL, STOP enforcement, and global halt: FREE-4.
- Mainnet beta and external-user certification: FREE-5 and FREE-6.
- Pricing and monetization: MON-1 after free-product evidence.

## 13. Owner decisions encoded

- Preserve the current ARIA terminal visual identity.
- Build through independently reviewable vertical increments.
- Replace demo dependencies with real backend state progressively.
- Do not activate funds or trading before their respective evidence gates.
- Keep the core product free during FREE phases; legacy licensing does not authorize the future funded product.

