# ARIA REAL-2 Execution State

**Launch target:** 2026-09-01  
**Mode:** controlled live beta  
**Architecture:** dedicated local ARIA trading wallet; cloud never receives wallet authority

## Current repository SHAs

- `AIWMCX/aria-telegram-BOT-APP` main: `e750ad57dd3ee987b7025422d5c862ede4bae305`
- `AIWMCX/aria-engine` main: `d15e445390e3ebf3446b7c1b2e404bf8a8816b09`
- `AIWMCX/aria-terminal-telegram` main: `13d8002e773019675a4db29897b861af579766f5`

## DONE

- Telegram account/license flow exists.
- `/license` customer UX no longer requires normal users to paste a token into `.env`.
- Device pairing and replay-resistant device authentication exist.
- ARIAE1 entitlement issuance/verification exists.
- Server-side revocation is propagated through the typed engine/cloud sync channel.
- Read-only Solana RPC observation exists.
- Real Jupiter/Raydium read-only market-price validation exists.
- Deterministic PAPER engine, local hard stop, crash recovery and periodic sync exist.
- Control plane has engine snapshots/events/commands storage and command delivery primitives.

## IN PROGRESS

- REAL-2 launch architecture and implementation planning.

## NEXT TASK

**REAL2-1 — dedicated local wallet foundation + real funding/readiness state.**

Deliverable:

- a new ARIA trading wallet can be created locally;
- the secret remains local and encrypted at rest;
- the public address persists across restart;
- real SOL balance is read from Solana;
- the control plane can receive only the public address/balance/readiness snapshot;
- Telegram terminal can show the public address and `FUND WALLET` instructions without exposing secret material;
- no transaction signing/broadcast is enabled by this first slice.

## BLOCKERS / RISKS

1. `aria-terminal-telegram` is still a July demo shell and must not remain a second independent backend.
2. REAL-2 local-wallet architecture is separate from the existing delegated-vendor funded-account architecture; the two must not share authority semantics.
3. Live-money execution remains disabled until wallet persistence, risk gates, execution idempotency and chain reconciliation are independently proven.
4. The Sep 1 date cannot waive a failed money-integrity or hard-stop gate.

## SECURITY INVARIANTS

- Trading-wallet private material exists only inside local `aria-engine` storage/runtime.
- No private key, seed, mnemonic or decrypted keystore is sent to Telegram, Railway, Vercel, Postgres or the terminal frontend.
- DeviceAuthIdentity and TradingWalletIdentity are separate keys, files, types and modules.
- Normal users never manually handle ARIA1/ARIAE1 tokens.
- START may be gated; STOP/status/diagnostics remain available.
- Cloud outage must never disable local STOP.
- A signed/broadcast transaction with uncertain RPC outcome is never blindly retried.
- All financial quantities use integer base units or explicit fixed-point representations.

## PROD ENV NAMES

Control plane currently includes environment categories for Telegram, entitlement signing, Stripe and PostgreSQL. Secret values are never recorded here.

REAL-2 local wallet must not introduce cloud environment variables containing wallet authority.

## LIVE TEST EVIDENCE

No REAL-2 live-money certification evidence exists yet.

Existing REAL-1 evidence includes real Telegram/control-plane interaction, live Solana RPC reads, real Jupiter/Raydium read-only market data and PAPER execution/recovery evidence.

## RELEASE GATE

- [ ] automatic account/license activation
- [ ] no customer `.env` editing
- [ ] device pairing
- [ ] dedicated local wallet creation
- [ ] encrypted local wallet persistence
- [ ] secret-absence proof for cloud/log/sync surfaces
- [ ] real SOL funding detected
- [ ] real wallet balance displayed in Telegram
- [ ] live-mode readiness gate
- [ ] live risk controls
- [ ] quote/preflight pipeline
- [ ] execution idempotency
- [ ] confirmed bounded mainnet buy
- [ ] confirmed bounded mainnet sell
- [ ] exact fill/position/PnL reconciliation
- [ ] START/PAUSE/STOP proof
- [ ] restart recovery with pending transaction
- [ ] duplicate-execution prevention
- [ ] Telegram state equals engine state
- [ ] clean-machine installation
- [ ] exact-SHA CI/release certification

## Session startup rule

Every future coding session should read only:

1. this file;
2. the implementation plan for the active task;
3. the latest commit(s) touching that task.

Do not reconstruct the project from old chat history unless one of those sources is insufficient.
