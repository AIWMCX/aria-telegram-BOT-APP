# AGENTS.md — ARIA Telegram Bot App

This file is the operating contract for Codex and other coding agents working in this repository.

## Mission

Maintain and extend the backend for the ARIA Sniper Terminal Telegram Mini App without weakening authentication, licensing, payment integrity, auditability, or deployment safety.

The repository is the shared API/backend and reference frontend. The primary customer-facing Mini App may be hosted separately in appss.pro.

## Repository role

- Backend/API: Hono + TypeScript on Node.js 22.
- Telegram bot: grammY.
- Reference Mini App frontend: `public/`.
- Trial/licensing storage: SQLite via Node `node:sqlite`.
- Funded-account domain: PostgreSQL when `DATABASE_URL` is configured.
- Payments: Stripe, feature-gated by environment configuration.
- Email: Resend.
- Deployment target: Railway using `Dockerfile` + `railway.json`.

Do not confuse this repository with the separate sniper execution engine. This repo issues and manages licenses; it does not perform Solana trade execution.

## Read before editing

Read these in order for any non-trivial task:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md`
4. Relevant files under `docs/`
5. The caller and callee files for the behavior being changed
6. Existing tests in `test/`

For funded-account, wallet, balance, ledger, signer, or custody-related changes, read `docs/ARIA_FUNDS_ARCHITECTURE_V1.md` before touching code.

## Required environment

- Node.js: `>=22.13.0`
- Package manager: npm
- Install dependencies with `npm ci` when `package-lock.json` is present.

Never downgrade Node below 22 without explicitly replacing the current `node:sqlite` design.

## Standard verification gates

Run the smallest relevant check first, then all repository gates before claiming completion:

```bash
npm ci
npm run typecheck
npm test
```

For server/runtime changes, also exercise the service locally when credentials are available:

```bash
npm run dev
curl -fsS http://localhost:8080/healthz
```

A change is not complete merely because it compiles. Report the exact commands run and their outcomes.

## Security invariants

These are hard constraints.

### Telegram authentication

- Never trust a Telegram user ID, username, wallet, or account identifier supplied directly by the client.
- Identity for authenticated Mini App actions must come from verified Telegram `initData`.
- Do not weaken `src/telegram-auth.ts` validation.
- Validate request bodies before database mutation.
- Preserve the current pattern: parse/validate input, verify Telegram authentication, then touch state.
- Prefer `x-init-data` or request-body transport over query strings for signed Telegram data so it does not leak through URLs or referrers.

### Secrets and bearer credentials

Never commit or print:

- `TELEGRAM_BOT_TOKEN`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `ARIA_LICENSE_PRIVATE_D`
- full license tokens
- production database credentials
- wallet private keys, seed phrases, signing keys, or custody secrets

`.env.example` must contain placeholders only. Real values belong in local `.env` files or Railway variables.

### Licensing

- `src/license-signer.ts` is security-sensitive. Keep it small and deterministic.
- License signing must remain Ed25519-based unless an explicit migration is designed and approved.
- Do not rotate `ARIA_LICENSE_PRIVATE_D` casually. Existing issued licenses depend on the matching public key.
- Never log full license bearer tokens.
- Every license issue, renewal, revocation, or state mutation must remain auditable.

### Stripe

- Stripe webhook requests must remain signature-verified.
- Do not trust browser/client claims that a payment succeeded.
- Payment/licensing state transitions must originate from verified Stripe events or verified server-side Stripe state.
- Preserve idempotent handling where implemented; add idempotency where a new payment mutation could be replayed.

### Auditability

Every database mutation in the business domain must call the existing audit mechanism unless the architecture document explicitly defines another immutable audit path.

### Financial / funded-account domain

Treat migrations, ledger logic, wallet accounts, chain events, deposits, withdrawals, signer adapters, and balance calculations as high-risk code.

For those changes:

- preserve integer/base-unit accounting;
- never derive authoritative balances from frontend state;
- require idempotent chain-event ingestion;
- do not introduce private-key custody into ordinary application code;
- add or update focused tests before changing behavior;
- perform an explicit security review before merging.

## API contracts used by appss.pro

The separately hosted appss.pro Mini App should integrate with this backend rather than duplicate backend logic.

Current important endpoints include:

- `GET /healthz`
- `GET /api/me` with Telegram `initData` in `x-init-data`
- `POST /api/auth/telegram`
- `POST /api/submit`
- `POST /api/checkout`
- `POST /api/webhook/stripe`
- `GET /api/license-by-order/:orderId`

When changing an API request or response shape:

1. treat the change as a public integration contract;
2. preserve backward compatibility when practical;
3. document the new shape;
4. update the reference frontend under `public/`;
5. state what must be changed manually in appss.pro.

Do not assume Codex has authenticated edit access to appss.pro. The repository is the source of truth for API behavior and the reference implementation.

## Railway deployment contract

Railway is expected to build from `Dockerfile` according to `railway.json`.

Production assumptions:

- service binds to `0.0.0.0`;
- `PORT` defaults to `8080` but Railway may provide it;
- `/healthz` is the deployment health check;
- persistent SQLite data requires `/data` persistence;
- `DB_PATH` is `/data/aria.db` in the Docker image;
- production secrets are Railway variables, never repository files;
- `PUBLIC_URL` must match the active HTTPS Railway domain;
- Telegram Mini Apps require HTTPS.

Do not change deployment files casually. Any `Dockerfile`, `railway.json`, database-path, port, or startup-command change must be verified against the runtime contract.

## Branch and change discipline

- Do not make speculative rewrites.
- Prefer the smallest complete change that satisfies the task.
- Preserve unrelated user work.
- Use a feature branch for non-trivial work.
- Do not push unverified code directly to `main`.
- Do not trigger production migrations or destructive data actions unless the task explicitly requires them.
- Schema changes must use migrations; do not silently mutate production schema at startup unless that is an existing intentional pattern.

## Coding conventions

- TypeScript strict mode must remain enabled.
- Prefer existing dependencies and Node standard-library functionality over new packages.
- Use Zod for untrusted request-body validation where the project already uses it.
- Keep configuration centralized in `src/config.ts`.
- Keep tier/cap constants centralized; do not duplicate business limits across handlers.
- Use the existing logger rather than `console.log` in application code.
- Do not expose internal errors, credentials, or raw third-party payloads to clients.
- Keep async notification failures from corrupting the primary transaction path, while logging failures appropriately.

## Testing expectations

Behavior changes should have a test that would fail before the change and pass after it whenever practical.

Pay particular attention to tests for:

- bad or expired Telegram `initData`;
- cross-user account/license access;
- input validation and honeypot behavior;
- rate limits;
- Stripe webhook replay/idempotency;
- refund/revocation mapping;
- license expiry and renewal;
- ledger invariants and duplicate chain events;
- error handling when optional Postgres or payment services are unavailable.

## Known boundaries / unfinished work

`CLAUDE.md` is the detailed handoff and contains the current known gaps. Do not treat TODOs as automatically authorized scope.

Notable boundaries include:

- appss.pro is a separately hosted frontend;
- the sniper execution engine is a separate repository;
- paid production launch has business/entity-separation constraints documented in the handoff;
- refund auto-revocation, expiry notifications, and crypto payment paths may still require completion depending on current branch state.

Verify the implementation before relying on any stale handoff statement.

## Definition of done

Before reporting a coding task complete, provide:

1. files changed;
2. behavioral impact;
3. tests/checks run and exact outcomes;
4. deployment/configuration changes required, if any;
5. appss.pro manual changes required, if any;
6. Railway variable/volume/domain changes required, if any;
7. unresolved risks or items not verified.
