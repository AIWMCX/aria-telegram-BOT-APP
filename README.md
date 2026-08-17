# ARIA Terminal Backend

Trial signup, licensing, and the backend for the ARIA Sniper Telegram Mini App.

**New here?** Read [`CLAUDE.md`](./CLAUDE.md) first — it has the broader architecture and deployment context. The FREE-1A product-reality design and implementation plan live under `docs/superpowers/`.

## Quick start

```bash
npm install
npm run keygen
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

Telegram Mini Apps require HTTPS. For local testing:

```bash
npx ngrok http 8080
# copy the HTTPS URL into .env as PUBLIC_URL
```

## Product reality contract

`GET /api/product-reality` is the backend-owned presentation truth for the Mini App. It reports only:

- `environment`
- `network`
- `dataMode`
- `executionMode`
- `controlState`
- `paymentsEnabled`

Default production state while real integrations are absent is:

```text
production / offline / simulated / disabled / stopped
```

The five optional operator variables are documented in `.env.example`:

```text
ARIA_PRODUCT_ENVIRONMENT
ARIA_NETWORK_MODE
ARIA_DATA_MODE
ARIA_EXECUTION_MODE
ARIA_CONTROL_STATE
```

Malformed reality configuration fails closed to unavailable/disabled/stopped. Unsupported or contradictory execution claims fail startup instead of being rendered as cosmetic live state. These fields are presentation truth only; they never authorize funds, signing, withdrawals, or trades.

Local verification:

```bash
npm ci
npm run typecheck
npm test
npm run dev
curl -s http://localhost:8080/api/product-reality
```

## Deploy to Railway

Connect `AIWMCX/aria-telegram-BOT-APP` to Railway and deploy from the approved `main` SHA only after CI passes for that exact SHA.

Railway requirements:

1. Mount persistent storage required by the existing SQLite license domain.
2. Configure environment variables without committing secrets.
3. Generate the public HTTPS domain and set `PUBLIC_URL`.
4. Confirm `/healthz`.
5. Confirm `/api/product-reality` returns the intended production reality state.
6. Confirm the shipped Mini App shows no stronger state than that response.

## Current product boundaries

The existing license/signup product remains operational. FREE-1A adds no funds, wallet provisioning, signing, withdrawals, or trade execution. Synthetic dashboard activity is demonstration data only and must remain visibly labeled `SIMULATED - NO REAL FUNDS`.

Existing funded-account groundwork in the repository is not automatically production-enabled; each financial capability remains gated by its own approved specification, tests, review, exact-SHA CI, deployment, and runtime evidence.
