# ARIA Funds Architecture v1

Status: **DRAFT — architecture only, no code written against this yet.**
Owner sign-off required before any deposit/ledger/withdrawal implementation starts.

## 1. Purpose

Defines how ARIA moves from "free license issuer" to "free funded account" —
specifically: who controls funds, how balance is tracked, and how money enters
and leaves the system. This document is the gate for `FREE-0` in the release
ladder. Nothing in `FREE-2` (ledger+deposit) or later gets implemented until
this is decided, because building ledger code before the custody model is
fixed means rebuilding the ledger later.

## 2. Custody classification — the one decision everything else depends on

Three options exist. ARIA is choosing between the first two; the third is
explicitly rejected.

| Model | Who signs transactions | Where keys live | Status |
|---|---|---|---|
| `CUSTODIAL` | ARIA, unrestricted | ARIA's backend/DB | **Rejected.** Turns Railway into a hot-wallet custodian. Any backend compromise = total user fund loss. Not being built. |
| `DELEGATED` (target) | A constrained, revocable authority — either a Solana program holding session-key-style permissions, or a custody-as-a-service vendor's policy engine (Turnkey / Privy / Dfns) | Vendor's HSM/MPC infrastructure, or an audited on-chain program — never ARIA's own database | **Preferred. Open sub-decision below.** |
| `NON_CUSTODIAL` (current, license product) | User, entirely | User's own wallet, own machine | What exists today. Compatible with a *view-only* portfolio UI but not with an in-app deposit/withdraw balance. |

**Why `DELEGATED`, not plain `NON_CUSTODIAL`, for the funded product:** the
stated product requirement is Telegram-native deposit/withdraw with ARIA
executing trades on the user's behalf without the user manually approving
each trade. That requires *some* automated signing authority. Pure
non-custodial (user approves every trade in their own wallet app) doesn't
match "ARIA ON → trades happen automatically." Delegated authority is the
minimum privilege that makes automated trading possible without ARIA holding
unrestricted keys.

### 2a. Open sub-decision: vendor-delegated vs. self-built program

| | Vendor (Turnkey / Privy / Dfns) | Self-built Solana program |
|---|---|---|
| Time to safe production | Weeks | Months (design + audit) |
| Audit burden | Vendor's, already done, ongoing | ARIA's — a real paid security audit, non-negotiable before real funds |
| Cost | Recurring vendor fee (Turnkey policy engine, Dfns ~$2,500/mo for a useful tier) | Audit cost (often $30k–$100k+) + engineering time |
| Control granularity | Whatever the vendor's policy engine exposes (Turnkey: program allowlist, amount caps, address restrictions — best fit found so far) | Unlimited — ARIA defines the exact program logic |
| Blast radius if compromised | Bounded by vendor policy engine | Bounded by ARIA's own program logic — only as good as the audit |

**This document does not resolve 2a.** It's marked
`PROFESSIONAL_REVIEW_REQUIRED` / owner decision. Recommendation carried
forward from prior session discussion: start with a vendor (fastest safe
path to real users), keep the self-built-program option open for later if
vendor economics or control granularity stop fitting. Everything below is
written to work under either choice — the ledger, state machines, and
domain model don't change based on which signer sits behind
`chain_transactions.signed_by`.

## 3. Domain model

### 3a. Identity: `leads` → `users`

`leads` (current) is keyed on `(tg_user_id, email)` — a marketing-capture
table, not an identity table. It already has a real bug class from that
design (fixed this session: same Telegram user, two emails, two rows). The
funded product needs identity keyed on Telegram user ID alone.

```
users
  id                    pk
  telegram_user_id      unique, not null
  telegram_username
  first_name
  last_name
  account_status         enum: active | disabled
  created_at
  updated_at
  last_seen_at
```

Migration approach: `users` is new, not a rename of `leads`. `leads` stays
as-is (it's the license product's data, still live) until the license
product is formally retired. A `users` row is created/looked-up the same
way `/api/me` already does identity resolution today — verified `initData`
→ `telegram_user_id` → row lookup — so the *pattern* carries over exactly,
only the target table changes for the free-funded product's own auth
endpoint (`POST /api/auth/telegram` or equivalent, additive, not replacing
`/api/me`).

### 3b. Wallet / trading account

```
wallet_accounts
  id                    pk
  user_id               fk -> users.id
  solana_pubkey          the account's Solana address
  authority_model        enum: delegated_vendor | delegated_program
  authority_ref          vendor account/policy ID, or program PDA — opaque to app logic
  status                 enum: active | revoked | suspended
  created_at
  revoked_at
```

One user may eventually have more than one wallet account (future), but v1
assumes one. `authority_ref` is intentionally opaque here — the ledger and
trading logic never need to know *how* signing happens, only that
`wallet_accounts.status = active` gates whether the execution engine is
allowed to request a signature at all.

### 3c. Ledger — the authoritative balance

**Rule, non-negotiable:** balance is never computed from the frontend, never
floating point. All amounts are integer base units (lamports for SOL,
token's native decimals for SPL tokens).

```
ledger_accounts
  id                    pk
  user_id               fk -> users.id
  asset                  e.g. "SOL", or SPL mint address
  available               integer, base units
  reserved                integer, base units
  pending                 integer, base units
  updated_at

ledger_entries            -- append-only, one row per state transition
  id                    pk
  ledger_account_id      fk
  event_type             enum: deposit_detected | deposit_confirmed | trade_reserved |
                               trade_spent | trade_released | trade_received |
                               network_fee | withdrawal_requested | withdrawal_reserved |
                               withdrawal_broadcast | withdrawal_confirmed |
                               withdrawal_failed | reconciliation_adjustment
  amount                 integer, base units (signed: +credit / -debit)
  balance_field           enum: available | reserved | pending
  reference_type          enum: deposit | withdrawal | trade | reconciliation
  reference_id            fk to the deposits/withdrawals/trade_intents row
  idempotency_key         unique — see 3f
  created_at
```

`ledger_accounts.available/reserved/pending` are **derived, cached
totals** — recomputable at any time as `SUM(ledger_entries.amount) WHERE
balance_field = X`. The entries table is the source of truth; the
cached total exists for read performance and gets reconciled against the
sum, not the other way around. This is what makes "opening state + valid
entries = closing state" (the audit's own accounting test) checkable by
construction.

### 3d. Deposits

```
deposits
  id                    pk
  user_id               fk
  wallet_account_id      fk
  asset
  amount                 integer, base units
  chain_tx_signature     unique — the actual on-chain signature, this is what prevents double-credit
  status                  enum: created | detected | confirming | confirmed | credited | failed | ignored
  confirmations           int
  detected_at
  confirmed_at
  credited_at
```

**Invariant:** `UNIQUE(chain_tx_signature)`. A rescan or restart that
re-observes the same signature is a no-op, enforced at the DB constraint
level, not just application logic — this is what makes "replay the same
event → no duplicate credit" actually hold under process restarts, not
just under normal operation.

### 3e. Withdrawals

```
withdrawals
  id                    pk
  user_id               fk
  wallet_account_id      fk
  asset
  amount                 integer, base units
  destination_address
  status                  enum: requested | validated | reserved | authorized |
                               broadcast | confirming | confirmed | failed
  idempotency_key         unique — see 3f
  chain_tx_signature      nullable until broadcast
  requested_at
  broadcast_at
  confirmed_at
  failure_reason
```

**Invariant:** moving `available → reserved` happens in the same DB
transaction as creating the `withdrawals` row and its `ledger_entries` row.
Two concurrent withdrawal requests for the same user race on that
transaction, not on application-level checks — this is what makes "two
concurrent withdrawals never spend the same funds" true under real
concurrency, not just true in the happy-path test.

### 3f. Idempotency

```
idempotency_keys
  key                   pk — client-supplied or derived (e.g. hash of user+action+amount+nonce)
  request_hash            hash of the full request body, to detect key-reuse-with-different-payload
  response_snapshot       the original response, replayed verbatim on retry
  created_at
```

Every state-changing financial endpoint (`POST /api/deposit/*`,
`POST /api/withdraw`) requires an idempotency key. A retried request with
the same key returns the original result without re-executing anything. A
reused key with a *different* payload is rejected outright — that mismatch
is itself a signal worth auditing, not silently accepting the new payload.

### 3g. Trading (for later, gated behind FREE-4 — noted here only so the ledger design accounts for it)

```
trade_intents        opportunity -> risk-evaluated -> a structured decision, pre-execution
chain_transactions    the actual signed/broadcast transaction, one per execution attempt
positions             asset, entry, cost basis, current qty, realized/unrealized PnL
fills                 individual execution results tied to a trade_intent
risk_events           any rejection, limit breach, or anomaly, for audit
```

Full design deferred to a `FREE-4` follow-up doc — listed here only to show
`ledger_entries.reference_type = 'trade'` and `trade_reserved` /
`trade_spent` / `trade_released` / `trade_received` events are already
accounted for in the ledger schema above, so the ledger doesn't need to
change shape when trading is added.

### 3h. Cross-cutting

```
audit_log             already exists in the license product — same pattern, expand to cover every financial mutation
system_controls        flags: global_halt, per_asset_halt, per_user_halt, withdrawals_halted
```

`system_controls` is checked at the top of every deposit-processing and
withdrawal-processing code path — a boolean read, not optional, not
bypassable by a code path that "forgot" to check.

## 4. Database: SQLite → PostgreSQL

SQLite (current) is fine for the license product — single writer, low
concurrency, no real money. It is explicitly **not** the target for the
ledger once real financial concurrency exists: SQLite's writer-serialization
model doesn't give the row-level transactional guarantees the withdrawal
concurrency invariant (3e) depends on under load, and `node:sqlite` has no
migration tooling story.

**Decision:** PostgreSQL for all new tables in section 3, from the start —
not a later migration. The license/`leads` tables stay in SQLite until that
product is retired; the two databases coexist during transition. Migrations
via a real migration tool (not hand-written `ALTER TABLE` in `db.ts` — that
pattern doesn't scale to a real schema with foreign keys and constraints).

## 5. Worker topology

Single-process (current `index.ts` boots DB + HTTP server + bot together) is
adequate for the license product. It is **not** adequate once financial
processing exists, per the failure-isolation requirement: a Telegram
polling failure must not stop accounting; a trading-feed failure must not
stop withdrawals.

Target separation (can start as separate async loops in one process,
graduate to separate Railway services if load requires it — no need to
over-build this on day one):

- **API** — HTTP surface, reads ledger, creates deposit/withdrawal requests
- **Telegram bot** — unchanged from today's retry-with-backoff pattern
- **Deposit monitor** — watches chain for incoming transactions to
  `wallet_accounts`, writes `deposits` rows
- **Withdrawal processor** — picks up `reserved` withdrawals, requests
  signature from the delegated authority, broadcasts, tracks confirmation
- **Reconciliation job** — periodic, compares on-chain balance vs. ledger
  totals, raises `P0_FINANCIAL_INCIDENT` on mismatch

## 6. Reconciliation

Runs on a schedule (not just on-demand). For each `wallet_account`:

```
on_chain_balance = getBalance(wallet.solana_pubkey)   -- real RPC call
ledger_balance    = SUM(ledger_accounts.available + reserved + pending) for that account
expected_balance  = on_chain_balance   -- these must be equal for a delegated (non-pooled) wallet
```

Any mismatch: halt withdrawals for that specific `wallet_account` (via
`system_controls`, scoped, not global) and raise an incident. Never
auto-correct a mismatch silently — a `reconciliation_adjustment`
ledger entry requires the same audit trail as any other financial event,
and requires the root cause to be understood first, per the audit's
automatic-failure standard.

## 7. Security invariants carried into this design

- No endpoint accepts a client-supplied balance, wallet authority, or
  Telegram identity — identity is always re-derived from verified
  `initData`, same pattern as today's `/api/me`.
- No plaintext private key is ever stored by ARIA, in either the vendor or
  self-built-program path — this is what the custody classification in §2
  exists to guarantee structurally, not by convention.
- Every ledger mutation is transactional, auditable, and idempotent (§3c,
  §3f) — not aspirational, enforced by DB constraints where possible
  (`UNIQUE(chain_tx_signature)`, `UNIQUE(idempotency_key)`).

## 8. What this document does NOT do

- It does not implement anything. No table in §3 exists yet.
- It does not resolve §2a (vendor vs. self-built delegated authority) —
  that's the actual next decision, and it's the owner's / a security
  professional's call, not something to default into by writing code.
- It does not cover trading engine internals beyond what's needed to show
  the ledger schema is forward-compatible (§3g).

## 9. Sequencing from here (unchanged from the agreed plan)

1. ~~Add CI~~ — done, `acbe9f8`.
2. This document — draft complete, awaiting owner sign-off, especially §2a.
3. Once §2a is resolved: stand up PostgreSQL, migrate `users` identity model
   (§3a), build `wallet_accounts` + ledger (§3b–§3c) with **no deposit or
   withdrawal endpoints live yet** — ledger plumbing first, proven with
   synthetic entries, before real money touches it.
4. Deposit pipeline (§3d), tested with controlled real funds per the audit's
   `AUDIT: DEPOSIT` checklist, before withdrawal.
5. Withdrawal pipeline (§3e), tested per `AUDIT: WITHDRAWAL`, including the
   concurrency and duplicate-request cases, before trading integration.
6. Only then: trading engine (§3g), gated behind `FREE-4`.
