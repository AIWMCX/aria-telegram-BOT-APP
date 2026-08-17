# ARIA REAL-1 operator runbook

## Deployment variables

Railway receives only control-plane variables: Telegram bot token, licence
signing keys, `PUBLIC_URL`, SQLite storage, PostgreSQL `DATABASE_URL`, and a
random `ARIA_ENGINE_CREDENTIAL_PEPPER` of at least 32 characters. It never
receives `ARIA_ENGINE_WALLET_REF`, `ARIA_ENGINE_PUBLIC_ADDRESS`,
`ARIA_ENGINE_RPC_URL`, or a customer licence token.

Run PostgreSQL migrations before enabling engine routes. The engine control
schema requires the existing `users` and `wallet_accounts` migration order,
then `1755241000000_create-engine-control.js`.

## Health checks

```powershell
Invoke-WebRequest https://<domain>/healthz
Invoke-WebRequest https://<domain>/api/product-reality
```

`/healthz` must return HTTP 200. `/api/product-reality` must return the
sanitized six-field product contract. Engine endpoints must return generic
authentication errors for missing/forged Telegram data or unsigned engine
requests.

## Pairing and device incident response

- Pairing codes expire after five minutes and are single-use.
- Credential hashes are stored in PostgreSQL; raw credentials are not stored.
- Revoke the device from its owning Telegram account after suspected loss.
- Verify that a revoked device receives HTTP 401 on heartbeat, commands, and
  event submission.
- If account isolation fails, revoke affected devices and halt the rollout.

## Freshness and STOP

The UI treats a heartbeat older than 15 seconds as disconnected. A local
engine treats a stale control session as a stop condition. STOP is accepted
idempotently and acknowledged by command ID. An engine with a tripped safety
latch cannot restart within that process.

## Logs and secrets

Allowed operational fields are engine version, network enum, public address,
lamport balance, licence status, state enum, command ID, event kind, and
timestamps. Do not log pairing codes, credentials, credential hashes, licence
tokens, RPC URLs, wallet references, private keys, seed phrases, or request
bodies containing them.

## Release gate

Release is blocked until exact-SHA CI passes install, backend/engine
typechecks, unit/API/frontend tests, a real PostgreSQL migration run, the
REAL-1 smoke test, and the secret/capability scan. Railway deployment must
match the merge SHA before production HTTP and Telegram-context checks.
