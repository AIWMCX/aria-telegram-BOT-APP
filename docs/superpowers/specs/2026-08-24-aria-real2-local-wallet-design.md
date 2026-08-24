# ARIA REAL-2 Local Trading Wallet Design

**Status:** APPROVED architecture baseline for implementation planning  
**Launch target:** 2026-09-01 controlled live beta  
**Decision:** Option B — dedicated local ARIA trading wallet

## 1. Product outcome

ARIA must become one operational product instead of three disconnected surfaces:

- `AIWMCX/aria-terminal-telegram` — customer-facing Telegram Mini App UI.
- `AIWMCX/aria-telegram-BOT-APP` — identity, entitlement, device registry, command queue, snapshots/events, audit and production control plane.
- `AIWMCX/aria-engine` — local private runtime, market observation, strategy/risk, local wallet authority, execution, confirmation, reconciliation and hard stop.

The user flow is:

`/start` -> automatic Telegram identity -> active license/entitlement -> `/pair` -> local engine pairing -> dedicated local wallet -> fund wallet -> readiness checks -> enable live mode -> start/pause/stop -> real positions/activity reflected back into Telegram.

Normal users never paste ARIA license or entitlement tokens into `.env` files. Tokens remain internal implementation details.

## 2. Baseline repository state

At design creation:

- control plane `main`: `e750ad57dd3ee987b7025422d5c862ede4bae305`
- engine `main`: `d15e445390e3ebf3446b7c1b2e404bf8a8816b09`
- terminal UI `main`: `13d8002e773019675a4db29897b861af579766f5`

The control plane and engine already have REAL-1 identity, pairing, entitlement, read-only Solana observation, real market-data validation, paper execution and signed engine/cloud sync foundations. The terminal UI is still a demo shell and must not be treated as execution truth until it is wired to the control plane.

## 3. Custody boundary

REAL-2 local-wallet execution is a separate architecture from `docs/ARIA_FUNDS_ARCHITECTURE_V1.md`'s delegated-vendor funded-account product.

REAL-2 local wallet rules:

1. A new dedicated Solana trading wallet is generated on the user's machine by `aria-engine`.
2. The wallet authority never enters Telegram, Railway, Vercel, Postgres, `aria-terminal-telegram`, or `aria-telegram-BOT-APP`.
3. The cloud stores only the public trading address plus non-secret state needed for display/audit.
4. `FUND WALLET` means displaying the self-custodied address/QR so the user can transfer SOL to that address. It is not an ARIA custodial deposit account.
5. The existing `DeviceAuthIdentity` remains cryptographically and structurally separate from the trading-wallet authority.
6. Importing a user's existing Phantom/Solflare seed/private key is out of scope for the September beta. Only a newly generated dedicated ARIA wallet is supported.

## 4. Local wallet storage

Wallet authority is created and consumed only by an isolated `aria-engine` wallet module.

Required properties:

- dedicated filesystem location under the existing ARIA runtime directory;
- encrypted at rest;
- strict file permissions where the OS supports them;
- no secret value in logs, diagnostics, crash reports, snapshots, sync payloads or telemetry;
- no API that returns/export the raw secret through the control plane;
- public address can be exposed through status/snapshot interfaces;
- wallet deletion/recovery semantics must be explicit; silent regeneration is forbidden because it would strand funded addresses.

For the TypeScript/Solana stack, new Solana transaction/signing work must use the currently recommended Solana TypeScript SDK family (`@solana/kit`) rather than introducing new code on legacy `@solana/web3.js` unless a documented compatibility blocker is proven.

## 5. Live execution boundary

Live execution is represented as a separate capability from PAPER. Existing PAPER behavior remains intact.

A live trade must pass this pipeline:

`MarketObservation -> TradeIntent -> RiskDecision -> Quote -> Preflight/Simulation -> Signing -> Broadcast -> Confirmation -> Fill/Reconciliation -> Position`

No stage may be skipped by a UI or remote command.

Required domain objects:

- `TradeIntent`: immutable requested economic action and idempotency key.
- `RiskDecision`: accepted/rejected with exact reason and effective limits.
- `ExecutionQuote`: provider route, input/output base units, slippage bound, fee estimate, expiry.
- `ExecutionAttempt`: intent + quote + attempt number + status.
- `ChainTransaction`: signature, blockhash validity metadata, broadcast/confirmation/finality state.
- `Fill`: actual executed base-unit amounts and fees.
- `LivePosition`: base-unit quantity, cost basis, realized/unrealized PnL and source transaction IDs.

All money quantities use integer base units or explicit fixed-point representations. UI decimal values are derived presentation only.

## 6. Risk and stop invariants

September live beta starts with conservative configurable ceilings and an operator-controlled allowlist. Required independent controls:

- maximum lamports per trade;
- maximum total live exposure;
- maximum simultaneous positions;
- daily realized-loss ceiling;
- minimum wallet SOL reserve for fees;
- maximum slippage basis points;
- maximum priority/network fee budget;
- market-data freshness and cross-source agreement gate;
- duplicate-intent/idempotency protection;
- per-mint allow/deny controls;
- global local HARD STOP.

STOP is local-first and cannot depend on cloud availability, subscription state or entitlement validity. Cloud STOP is advisory delivery into the existing signed command channel; the local engine remains the final authority.

## 7. Cloud/Telegram boundary

The cloud may know:

- trading wallet public address;
- observed SOL/token balances;
- engine/device online state;
- mode and readiness state;
- configured public risk limits;
- positions, fills, PnL and transaction signatures;
- command/audit history.

The cloud must never receive:

- trading wallet private material;
- seed phrase/mnemonic;
- decrypted keystore content;
- signing session material sufficient to move funds.

The Mini App becomes a rendering/control surface over authenticated control-plane data. It never invents positions, balances, fills or PnL.

## 8. Terminal UX

The September beta terminal must replace simulated values with authenticated real state and clearly distinguish PAPER from LIVE.

Minimum visible state:

- account/license status;
- paired device and last-seen state;
- trading-wallet public address;
- live SOL balance;
- engine mode and readiness;
- market-feed freshness;
- effective risk limits;
- positions and PnL;
- recent detections/rejections/trade attempts/fills;
- START, PAUSE and STOP controls;
- FUND WALLET copy/QR action;
- transaction explorer links after broadcast.

LIVE cannot be enabled if wallet, entitlement, market, RPC, risk, persistence or recovery readiness checks fail.

## 9. Persistence and recovery

Live state must survive process and machine restarts without duplicate execution.

Required persisted local truth:

- wallet metadata and encrypted authority;
- monotonic local execution sequence;
- trade intents and idempotency keys;
- submitted transaction signatures;
- pending confirmation states;
- fills/positions;
- daily risk counters;
- processed command IDs.

On restart, unresolved submitted transactions are reconciled from chain state before any retry. A timeout after a signed/broadcast transaction is never treated as proof of failure.

## 10. Release decomposition

The launch program is split into independently reviewable slices:

1. Local wallet foundation and funding/readiness UX.
2. Live execution domain + signer boundary, without mainnet broadcast enabled by default.
3. Tiny-value swap adapter and confirmation/reconciliation.
4. Live risk engine and hard-stop integration.
5. Real terminal/control-plane integration replacing demo state.
6. Crash/restart, duplicate-prevention and money-integrity certification.
7. Exact-SHA controlled-mainnet beta certification and operations runbook.

Each slice uses RED -> GREEN -> regression -> security review -> commit -> CI -> exact-SHA evidence. No slice is declared complete from source inspection alone.

## 11. September 1 acceptance gate

The controlled live beta is release-ready only when all are evidenced on exact release SHAs:

- automatic account/license activation with no customer `.env` editing;
- device pairing and entitlement valid;
- dedicated wallet created locally and persistent across restart;
- wallet secret confirmed absent from cloud payloads/logs;
- real SOL funding detected;
- real market data and RPC readiness green;
- risk gates enforced before every live attempt;
- one bounded real buy confirmed on mainnet;
- one bounded real sell confirmed on mainnet;
- fills/PnL reconcile to chain evidence;
- START/PAUSE/STOP proven;
- cloud outage does not disable local STOP;
- process crash with pending/confirmed transaction recovers without duplicate execution;
- Telegram displays the same wallet/position/fill state as the engine;
- release artifact identifies exact source SHAs and passes clean-machine setup.

The September date is a target, not permission to waive any acceptance gate. If a live-money gate is unproven on September 1, the release remains PAPER or limited internal testing until that gate is proven.
