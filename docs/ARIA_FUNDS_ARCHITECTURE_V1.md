# ARIA Funds Architecture v1

Status: **ACCEPTED WITH AMENDMENTS (v1.1) — architecture only, no code
written against this yet.** Revised after independent review: chain-event
uniqueness generalized beyond transaction signature (§3d), ledger upgraded
to journal/posting semantics (§3c), withdrawal uncertainty made a
first-class state (§3e), reconciliation made asset- and
commitment-aware (§6), and §2a resolved below (`DELEGATED_VENDOR` for v1).

## 0. Decision record (ADR)

> Adopt `DELEGATED_VENDOR` as the ARIA Free v1 funds-authority architecture.
> Reject unrestricted ARIA-held private keys. Use a vendor-neutral
> `SignerPort` abstraction (§2a) so the financial domain never depends
> directly on Turnkey/Privy/any specific vendor's API. Run Turnkey as the
> first constrained-Solana-signing POC and Privy as the comparison
> implementation. Defer any self-built Solana authorization program until
> ARIA has validated real users/volume and can justify the independent
> security-audit expense. No ledger/deposit/withdrawal code gets written
> until GitHub CI is green (§9 step 0) and this ADR has owner sign-off.

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

### 2a. Resolved: `DELEGATED_VENDOR` for v1

| | Vendor (Turnkey / Privy / Dfns) | Self-built Solana program |
|---|---|---|
| Time to safe production | Weeks | Months (design + audit) |
| Audit burden | Vendor's, already done, ongoing | ARIA's — a real paid security audit, non-negotiable before real funds |
| Cost | Recurring vendor fee — not decision-grade until separately quoted per §2a-i | Audit cost (often $30k–$100k+) + engineering time |
| Control granularity | Whatever the vendor's policy engine exposes | Unlimited — ARIA defines the exact program logic |
| Blast radius if compromised | Bounded by vendor policy engine | Bounded by ARIA's own program logic — only as good as the audit |

**Decision:** `DELEGATED_VENDOR` for the initial commercial beta (see ADR,
§0). Self-built Solana authorization program deferred until real user/volume
evidence justifies the audit expense.

**Evaluation order:** Turnkey first (POC), Privy second (comparison
implementation), Dfns evaluated separately and with caution — its own
policy documentation states the policy engine does not apply to delegated
wallets, since end-user activity on a delegated wallet bypasses it. That
doesn't disqualify Dfns outright, but it means Dfns's "delegated wallet"
mode needs a deeper architecture check before assuming it provides the same
policy-bounded automation model as Turnkey/Privy.

**Why Turnkey first:** its Solana policy engine can inspect and constrain
program interactions, accounts, and SOL/token transfers, with IDL support
letting policies understand Solana program calls rather than just raw
instruction bytes — the closest fit to the ARIA policy shape below.

```
ALLOW:
  approved swap programs
  approved System/Token/ATA programs
  approved user wallet
  <= per-trade spend limit
  <= daily authorization limit
  expected token mints
  bounded fees

DENY:
  arbitrary SOL transfer
  arbitrary destination
  unapproved program
  arbitrary token approval
  wallet authority modification
  key export
```

**`SignerPort` abstraction:** the financial domain (ledger, withdrawal
processor, execution engine) never calls Turnkey/Privy/Dfns SDKs directly.
It calls an internal `SignerPort` interface (`requestSignature`,
`getPolicyState`, `revokeAuthority`) that a vendor-specific adapter
implements. This is what makes `wallet_accounts.authority_ref` (§3b)
genuinely opaque to app logic and keeps a future vendor swap or
self-built-program migration from requiring a ledger rewrite.

#### §2a-i. Not yet decision-grade

Vendor pricing above is directional only (e.g. Dfns's ~$2,500/mo figure)
and must be separately re-quoted against ARIA's actual expected user/volume
numbers before any commercial contract is signed — this document does not
treat those figures as verified.

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

### 3c. Ledger — journal/posting semantics

**Rule, non-negotiable:** balance is never computed from the frontend, never
floating point. All amounts are integer base units (lamports for SOL,
token's native decimals for SPL tokens).

Revised from a plain signed-entries model to true double-entry journal
semantics: every economic operation writes one `journal_entries` row and
two or more balanced `ledger_postings` rows whose amounts sum to zero per
asset. This is strictly stronger than isolated signed mutations to
`available`/`reserved`/`pending` — it makes "for every journal and asset,
postings sum to zero" a mechanically checkable invariant, not just a
convention.

```
ledger_accounts
  id                    pk
  user_id               fk -> users.id      -- null for system/clearing accounts, see below
  account_type            enum: user | external_clearing | withdrawal_clearing | fee_clearing
  asset                  e.g. "SOL", or SPL mint address
  available               integer, base units  -- derived/cached, see below
  reserved                integer, base units  -- derived/cached
  pending                 integer, base units  -- derived/cached
  updated_at

journal_entries           -- one per economic operation
  id                    pk
  event_type              enum: deposit_confirmed | trade_reserved | trade_spent |
                               trade_released | trade_received | network_fee |
                               withdrawal_reserved | withdrawal_broadcast |
                               withdrawal_confirmed | withdrawal_failed |
                               reconciliation_adjustment
  reference_type           enum: deposit | withdrawal | trade | reconciliation
  reference_id              fk to the deposits/withdrawals/trade_intents row
  idempotency_key           unique — see 3f
  created_at

ledger_postings            -- >=2 rows per journal_entries row; MUST sum to 0 per asset within a journal
  id                    pk
  journal_entry_id        fk -> journal_entries.id
  ledger_account_id        fk -> ledger_accounts.id
  asset
  amount                    integer, base units (signed: +credit / -debit)
  balance_field             enum: available | reserved | pending
```

Example — deposit confirmed (1 SOL):
```
external_clearing SOL   -1 SOL  (available)
user available SOL      +1 SOL  (available)
```
Withdrawal reservation:
```
user available SOL      -1 SOL  (available)
user reserved SOL       +1 SOL  (reserved)
```
Confirmed withdrawal:
```
user reserved SOL       -1 SOL  (reserved)
withdrawal_clearing SOL +1 SOL  (available)
```

`ledger_accounts.available/reserved/pending` are **derived, cached
totals** — recomputable at any time as `SUM(ledger_postings.amount) WHERE
balance_field = X`. `ledger_postings` is the source of truth; the cached
total exists for read performance and gets reconciled against the sum, not
the other way around.

### 3d. Deposits and exact-once crediting

Transaction-signature uniqueness alone is not sufficient on Solana: a
single transaction can carry multiple instructions, including multiple
transfers to different accounts in one signature. Identity has to live at
the instruction/event level, not the transaction level.

```
chain_events               -- one row per economically meaningful instruction observed on-chain
  id                    pk
  signature                the transaction signature (NOT unique alone)
  instruction_index
  inner_instruction_index   nullable
  account                   the affected account
  asset_mint                null for native SOL, mint address for SPL
  amount                    integer, base units
  event_type                enum: transfer_in | transfer_out | ...
  slot                      the Solana slot the event was observed in
  commitment                 enum: processed | confirmed | finalized

  UNIQUE (signature, instruction_index, inner_instruction_index, account, asset_mint, event_type)

deposits
  id                    pk
  user_id               fk
  wallet_account_id      fk
  chain_event_id         fk -> chain_events.id, unique   -- one deposit per chain_event, not per signature
  asset
  amount                 integer, base units
  status                  enum: created | detected | confirming | confirmed | credited | failed | ignored
  detected_at
  confirmed_at
  credited_at
```

**Invariant:** the `UNIQUE` constraint on `chain_events` is what makes
exact-once processing hold at the transfer/event level under restart or
rescan — not the transaction signature by itself. A `deposits` row only
exists once its backing `chain_event` is uniquely recorded, and the FK
uniqueness on `chain_event_id` prevents a second `deposits` row from ever
attaching to the same event.

### 3e. Withdrawals — uncertainty is a first-class state

A network timeout after broadcasting a withdrawal transaction does **not**
prove the transaction failed — the transaction may still land. Releasing
reserved funds back to `available` on a mere RPC timeout risks a double
withdrawal if the original transaction later confirms. The state machine
has to represent "we don't know yet" as its own state, not collapse it
into `failed`.

```
withdrawals
  id                    pk
  user_id               fk
  wallet_account_id      fk
  asset
  amount                 integer, base units
  destination_address
  status                  enum: requested | validated | reserved | signing | signed |
                               broadcast | confirmation_pending | confirmed |
                               failed_prebroadcast | broadcast_unknown | expired |
                               cancelled | manual_review
  idempotency_key         unique — see 3f
  chain_tx_signature      nullable until signed
  requested_at
  broadcast_at
  confirmed_at
  failure_reason
```

**Invariant:** moving `available → reserved` happens in the same DB
transaction as creating the `withdrawals` row and its `ledger_postings`
rows. Two concurrent withdrawal requests for the same user race on that
transaction, not on application-level checks.

**Invariant:** once a withdrawal has reached `signed` or later, funds are
never released back to `available` on a timeout or RPC error alone — that
outcome routes to `broadcast_unknown`, which is resolved only by querying
chain state for the signature (confirmed → `confirmed`; genuinely absent
after the transaction's blockhash expires → `expired`, only then eligible
for fund release, and even then via the reconciliation job, not the
request handler that timed out). Anything the reconciliation job can't
resolve automatically routes to `manual_review`, not to a guessed outcome.

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
`journal_entries.reference_type = 'trade'` and `trade_reserved` /
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

Runs on a schedule (not just on-demand). Native SOL and SPL tokens are
reconciled **per asset**, not as a single wallet-level number — Solana
holds SPL balances in separate token accounts (owner+mint derived), so
`getBalance()` on the wallet pubkey only ever covers native SOL:

```
for each wallet_account:
  # native SOL
  on_chain_sol      = getBalance(wallet.solana_pubkey)          -- real RPC call
  ledger_sol        = SUM(ledger_accounts WHERE asset='SOL': available+reserved+pending)

  # each SPL asset the wallet has ever held
  for each associated token account (owner=wallet.solana_pubkey, mint=X):
    on_chain_token_X  = getTokenAccountBalance(ata)              -- real RPC call
    ledger_token_X    = SUM(ledger_accounts WHERE asset=X: available+reserved+pending)

  # every on_chain_* must equal its corresponding ledger_* for a delegated, non-pooled wallet
```

Reconciliation reads and records **slot and commitment level**
(`processed` / `confirmed` / `finalized`), not a generic "confirmations"
counter — that's the concept Solana's RPC actually exposes, and it's what
`chain_events.commitment` (§3d) is for. A balance read at `processed` can
still roll back; only `finalized` (or the policy-defined minimum
commitment) is treated as settled for reconciliation purposes.

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
- It does not obtain vendor pricing at decision-grade accuracy (§2a-i) —
  that requires an actual quote against real expected volume.
- It does not cover trading engine internals beyond what's needed to show
  the ledger schema is forward-compatible (§3g).

## 9. Sequencing from here

0. **Fix CI red.** Done — `e0b8ca7`. Root cause was `node:sqlite` requiring
   Node ≥22.13.0 (flag dropped there) while CI pinned the literal string
   `"22.5"`, resolving to exact v22.5.0. Production was unaffected —
   `node:22-slim` floats to the latest 22.x patch. Confirmed genuinely green
   by polling the real GitHub Actions run, not assumed from a passing local
   test.
1. This document — accepted with amendments (v1.1), ADR recorded in §0,
   §2a resolved (`DELEGATED_VENDOR`). Awaiting final owner sign-off.
2. Vendor signer POC with **zero real user funds** — Turnkey first, Privy as
   comparison, against Solana devnet.
3. Stand up PostgreSQL + migrations.
4. Migrate `users` identity model (§3a).
5. Build `wallet_accounts` (§3b).
6. Build the double-entry ledger — `ledger_accounts` / `journal_entries` /
   `ledger_postings` (§3c) — with **no deposit or withdrawal endpoint live
   yet**, proven with synthetic journal entries first.
7. Build the reconciliation engine (§6) against synthetic fixtures before
   it ever touches a real wallet.
8. Controlled devnet deposit, tested against the full `AUDIT: DEPOSIT`
   checklist including duplicate-event replay at the `chain_events` level.
9. Controlled devnet withdrawal, tested against `AUDIT: WITHDRAWAL`,
   including the `broadcast_unknown` recovery path specifically.
10. Adversarial concurrency/idempotency tests — concurrent withdrawal
    requests, idempotency-key reuse with a mismatched payload, restart
    mid-`signing`.
11. Controlled mainnet tiny-value test — real SOL, minimal amount, full
    lifecycle, before any real user is let near it.
12. Only then: `FREE-2`/`FREE-3` certification against the independent
    audit standard.
13. Trading architecture (`FREE-4`, §3g) — separate follow-up document.

This sequence deliberately does not put a Deposit/Withdraw button in front
of a real user quickly. It puts the ledger, reconciliation, and failure-mode
handling in front of synthetic and devnet tests first — that ordering is
the actual point of this document.
