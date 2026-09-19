# LIVE Vertical Slice 0.1 — implementation ledger

Program: **LIVE Vertical Slice 0.1 (Founding Beta, non-custodial)**
Spec: `docs/SPEC-LIVE-VERTICAL-SLICE-0.1.md` on branch `plan/live-vertical-slice-0.1`
Schema proposal: `docs/proposed-002_trading_accounts.sql` on the same branch

This is a **different program** from the hosted-engine work; its ledger
(`2026-09-08-hosted-engine-LEDGER.md`) is deliberately untouched.

---

## Milestone 1: TradingAccount + TradeIntent + Firewall (backend only, no signing/submission)

**Status: `IMPLEMENTED (awaiting review)`**
Branch: `impl/live-vertical-slice-0.1-milestone-1`
Date: 2026-09-19

This is the first REAL code in this program. Everything before it was
PAPER-only or architecture documents.

### What was built

| Artifact | What it is |
|---|---|
| `migrations/1758240000000_create-trading-accounts.js` | The spec's companion schema proposal, promoted verbatim to a real migration, plus three additions noted below. Creates `wallet_ownership_proofs`, `live_consents`, `live_risk_policies`, `trading_accounts`, `trade_intents`, `live_positions`; adds `self_custody` to the existing `authority_model` enum. |
| `src/live/live-limits.ts` | The single place every LIVE cap, bound and timing constant lives (`TIER_LIMITS` convention). `CURRENT_CONSENT_VERSION`, `FOUNDING_BETA_HARD_CAPS`, `RISK_POLICY_BOUNDS`, `LIVE_TIMING`, `ALLOWED_PROGRAM_IDS`, `MAX_ORACLE_DIVERGENCE_BPS`. Env-free by design. |
| `src/live/money.ts` | The quoted-vs-realized money boundary. Wrapper types, not branded primitives, so the distinction survives serialization. `realizedLamports()` cannot be called without landed-transaction evidence. |
| `src/live/trading-account.ts` | The TradingAccount state machine. `deriveAccountState()` walks the spec's evidence ladder; `requestAccountTransition()` re-derives on every call so ARM is never granted because the UI asked. Pure, DB-free. Includes `validateRiskPolicy()`. |
| `src/live/wallet-ownership.ts` | Server-side Ed25519 ownership-proof verification over a server-issued challenge, with a local base58 codec (no new dependency). Accepts base64 **or** base58 signatures so the founder can paste from Phantom or a CLI. |
| `src/live/trade-intent.ts` | The TradeIntent state machine, the `INTENT_TRANSITIONS` cause table, `computeIdempotencyKey()`, the strict engine-proposal Zod schema, and `buildTradeIntentDraft()`. Pure. |
| `src/live/transaction-firewall.ts` | 22 declarative gates (F0–F21), pure `evaluateFirewall()`, plus `recordFirewallDecision()` which audits and logs EVERY decision. `UNCERTAIN = REJECT` on every gate. |
| `src/live/live-intents-repo.ts` | Persistence. `createTradeIntent()` is `INSERT … ON CONFLICT (idempotency_key) DO NOTHING` + re-SELECT, so a losing race returns the existing row rather than raising. Plus F8/F17's real queries. |
| `src/config.ts` (modified) | `LIVE_ENABLED` and `LIVE_FOUNDER_TELEGRAM_IDS` env vars + `liveRuntimeGates()`. Both default to the closed value; an empty allowlist admits nobody. |
| `.env.example`, `tsconfig.json`, `package.json` (modified) | Documented the new vars; excluded the negative-type fixture directory; wired the six new suites into `npm test`. |

### Additions beyond the approved schema proposal (flag these in review)

1. `trading_accounts.founder_allowlisted` + `founder_telegram_user_id`, with a
   CHECK that an allowlisted row must name its founder. The founder gate then
   requires **both** the row flag and membership of the config allowlist, so
   neither a stray `UPDATE` nor a stray env var can admit anybody alone.
2. `wallet_ownership_proofs.challenge_message` — the exact challenged bytes are
   persisted rather than re-derived at verify time. Re-derivation drift would
   silently turn real proofs into failures, or make two messages both valid for
   one nonce.
3. Three extra `trade_intents` CHECKs: `confirmed_at` only in CONFIRMED/RECONCILED,
   `reconciled_at` only in RECONCILED, and a REJECTED row must carry its code.
   These are the schema half of "SUBMITTED is never CONFIRMED".

### Tests (244 new checks — 212 pure/generated + 32 real-Postgres schema-contract, all passing; `npm test` (349 total checks) and `npm run typecheck` clean)

| Suite | Checks | Covers |
|---|---|---|
| `test/live-trading-account.ts` | 57 | Every evidence gate; ARM refused on stale balance / stale consent / non-founder; STOPPED proven to have no outgoing transition; risk-policy validation incl. the Founding Beta caps; ownership proof verify/reject paths; the strict submission schema. Spec T1–T5, T7, T48. |
| `test/live-trade-intent.ts` | 42 | Every legal and illegal intent transition; FAILED unreachable by any timeout cause; SUBMITTED ≠ success; CONFIRMED ≠ position; terminal states null the signed bytes; idempotency-key purity. Spec T9, T10. |
| `test/live-firewall.ts` | 63 | One test per gate failing only that gate; UNCERTAIN=REJECT on 14 distinct unavailable inputs; evidence on approval; pass 2 a strict superset of pass 1; **every rejection's exact code read back out of the audit log**. Spec T13–T16, T18. |
| `test/live-type-boundary.ts` | 6 | Compiles a fixture of 7 quoted/realized confusions and asserts TypeScript rejects each one **on its own line**. |
| `test/live-migration-sql.ts` | 44 | Generates the migration's DDL via node-pg-migrate's own builder: every table, enum, CHECK, unique index; all money columns bigint; no key-material column name. |
| `test/live-schema-contract.ts` | 32 | **Now actually run against real Postgres — see below.** |

### UPDATE 2026-09-19 (later same day): the concurrency proof has now actually run

The gap described below is closed. Docker Desktop's engine was still not
usable (GUI processes were up but `docker info`/`version`/`ps` all hung for
60s+, and the `docker-desktop` WSL distro reported `Stopped`), and this org's
Supabase account was at its 2-active-free-project cap (both occupied by
unrelated projects — `sun-city-moving-dev` and the production `AIWMC QUANTIS`,
neither touched). With explicit product-owner approval, PostgreSQL was
obtained a third way: the official portable EnterpriseDB Windows binaries
(zip, no installer) run as an ordinary user process — no Windows service, no
admin rights used — `pg_ctl` bound only to `127.0.0.1` on a non-default port,
data directory under a scratch path outside this repo.

Exact steps run:

1. Downloaded `postgresql-17.6-1-windows-x64-binaries.zip` from
   `get.enterprisedb.com`, extracted to a scratch directory.
2. `initdb` a fresh data directory, `pg_ctl start` listening on
   `127.0.0.1:55432` only.
3. `createdb aria_live_test` — the name contains `test`, satisfying the
   guard regex `/test|dev|ephemeral|local/i` in `live-schema-contract.ts`.
4. Confirmed this repo's `.env` has **no `DATABASE_URL` set at all**, so the
   test's "must not equal the configured `DATABASE_URL`" refusal is trivially
   satisfied and no production database was anywhere in scope.
5. Ran the real migration tool against it:
   `npx node-pg-migrate up --database-url-var LIVE_TEST_DATABASE_URL -m migrations`
   — all 13 migrations, including `1758240000000_create-trading-accounts`,
   applied with **zero errors**.
6. Ran `LIVE_TEST_DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/aria_live_test npx tsx test/live-schema-contract.ts`
   for real (not skipped — the guard passed, the suite executed against a live
   Postgres 17.6 instance).

**Result: all 32 checks passed, zero failures.** In particular:

- **T11 (the critical one): two genuinely simultaneous `createTradeIntent()`
  calls with the same idempotency key** (fired via `Promise.all`, both
  in-flight before either commits) **produced exactly one row** —
  `SELECT count(*) FROM trade_intents WHERE idempotency_key = $1` returned
  `1`. Both callers received the identical row id. Exactly one of the two
  (`created: true`) was told it created the row; the other received the
  existing row with no exception thrown. This is the DB-level UNIQUE
  constraint on `trade_intents.idempotency_key` doing the work — proven
  under real concurrency, not asserted by application logic.
- T12: the partial unique index blocking a second non-terminal intent for
  the same `(account, mint, side)` — confirmed blocked, then confirmed
  freed once the first intent reached a terminal state.
- All CHECK constraints (ARMED requires `armed_until`, arm window bounds,
  founder-naming, risk-policy sanity bounds, terminal-state signed-bytes
  cleanup, confirmed/reconciled state guards, REJECTED-requires-code,
  BUY/SELL amount shape) — each independently confirmed REFUSED or ACCEPTED
  by real Postgres, matching the schema's intent.
- T47: no column across all 6 LIVE tables matches
  `/secret|private|seed|mnemonic|keypair/i` (mechanically inspected, not
  assumed — 50+ columns actually enumerated via `information_schema`).

Then ran the **full suite with `LIVE_TEST_DATABASE_URL` set**:
`npm test` — **349 checks passed, 0 failed, 0 skipped** (schema-contract's
32 checks are counted in that total and are no longer the "(skipped)" line
above). `npm run typecheck` — clean, zero errors.

**The idempotency guarantee is now demonstrated, not just designed.**

Cleanup / disposal note: the disposable Postgres instance lives entirely
under this machine's temp scratch directory as a plain user process (not a
registered Windows service), and no connection string, password, or
credential was committed anywhere in this repo — `LIVE_TEST_DATABASE_URL`
was only ever set as a shell environment variable for these commands. It can
be stopped and the data directory deleted at any time with no effect on any
other system.

### Original honest-gap note, superseded by the above (kept for history)

No Postgres was reachable in this environment. `DATABASE_URL` is **unset** in
this checkout (`.env` contains no such line), so **no production database was
touched, contacted, or could have been** — but equally, nothing was applied
anywhere. Docker Desktop's engine would not start (`com.docker.service` stopped,
both WSL distros stopped) and WSL has no Postgres and no passwordless sudo.

What that meant at the time:

- The migration was **well-formed**, proven by `test/live-migration-sql.ts`
  generating its full DDL through node-pg-migrate's real builder.
- The migration was **not proven to apply**. Postgres-only failures — an enum
  ordering problem, a CHECK referencing a column typo, an index predicate
  Postgres rejects — would not have been caught.
- `test/live-schema-contract.ts` was wired into `npm test`, but **skipped**
  (exit 0, loudly) without `LIVE_TEST_DATABASE_URL`.
- **The real concurrency proof had not yet run.**

This has now been resolved — see the update above.

### Explicitly NOT built in Milestone 1

- **No wallet-adapter / WalletConnect / Reown / Telegram Mini App signing UI.**
  Milestone 1 has only the server-side ownership-proof verifier, exercised by
  pasting a signature produced externally. P0-WALLET-1 (does the target wallet
  offer `solana_signTransaction` or only `solana_signAndSendTransaction`?)
  remains an open research question with a real chance of a negative answer.
- **No unsigned-transaction construction.** No Jupiter Swap API V2 client, no
  `route-client.ts`. P0-ROUTE-1 (re-verify the live endpoint shape) is open.
- **No submission.** No `submitter.ts`, no `sendRawTransaction`, no Deliverer.
- **No confirmation polling, no §12 UNKNOWN recovery.** An intent can *reach*
  UNKNOWN in the state machine; nothing resolves it. Today an UNKNOWN can only
  be cleared by a human.
- **No reconciler and no position creation.** `live_positions` exists as a
  table and has zero writers.
- **No preview rendering, no price oracle, no simulation.** Firewall gates
  F14/F15b/F16 are implemented and tested but have no production caller
  supplying their inputs.
- **No real on-chain balance observation.** There is no Solana RPC client in
  this repo (checked: `wallet-accounts.ts` and `ledger.ts` are delegated-custody
  bookkeeping only). The firewall consumes a balance *observation with a
  freshness stamp* exactly as spec §6 F6 specifies, and rejects when it is
  absent or stale. **Nothing currently produces that observation**, so in
  practice every account is stuck at CONNECTED until an observer exists.
- **No Telegram bot command wiring.** `src/bot.ts`, `src/server.ts` and
  `src/index.ts` are **untouched**. Nothing under `src/live/` is reachable from
  any live surface. That wiring is a deliberate later step needing its own review.
- **No consent disclosure file.** `CURRENT_CONSENT_VERSION` exists;
  `public/legal/live-risk-disclosure-live-0.1-2026-09-19.md` does not, because
  nothing serves consent yet.
- **No `aria-engine` changes at all.** No `IntentProposer`, no new journal event
  types. The §23.1 second-whitelist hazard (`NON_PAPER_EVENT_TYPES` in
  `event-journal.ts` must be updated alongside `journal-events.ts`) is
  **still ahead of us, not behind us** — it has not been triggered because no
  event type was added.
- **No boot-time recovery sweep, no HARD STOP module, no integrity checks.**

### Before a founder canary trade is possible

Everything in the list above, plus: a real balance observer, `LIVE_ENABLED=true`,
a `founder_allowlisted` account row naming a Telegram id present in
`LIVE_FOUNDER_TELEGRAM_IDS`, and spec §27's G0 gate (every P0 closed, both repos'
suites green, `aria audit-paper` passing on a genuine PAPER run).

### Standing rules this milestone was built under

- ARIA never receives, stores or handles a private key, seed phrase or wallet
  secret, at any layer. No module here has a parameter, schema field or column
  capable of accepting one; asserted mechanically in three suites.
- Every financial state transition has a test proving it is correctly gated AND
  correctly rejected when preconditions are not met.
- No Firewall rejection is silently swallowed: every decision writes an audit
  row carrying its exact code, and the test reads those rows back.
- `UNCERTAIN = REJECT` on every gate, with no soft-pass branch anywhere.
- A submitted transaction is never called confirmed; a quoted amount is never
  called realized. Both are enforced by the type system and the schema, not by
  convention.
