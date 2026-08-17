# REAL-1: ARIA Local Engine and Telegram Control Center

Status: **APPROVED FOR PLANNING**
Date: 2026-08-17
Product mode: **commercial paper-trading beta**

## 1. Decision and product promise

ARIA will be a non-custodial product. A customer runs the ARIA Engine on
their own computer. Their wallet private key, seed phrase, raw wallet file,
and RPC credential remain local to that computer. Telegram is the account,
setup, control, and monitoring surface; it is not a signing surface.

REAL-1 delivers a usable paper-trading beta: real local configuration, a
validated licence, Solana RPC network and public-balance reads, local
strategy evaluation, paper positions and PnL, and a Telegram Mini App that
displays only state reported by the paired engine. It does not sign, submit,
or simulate a real on-chain trade.

The current licence/control-plane product stays intact. REAL-1 is additive.

## 2. Non-negotiable constraints

- No private key, seed phrase, wallet file, or RPC URL is uploaded to ARIA,
  emitted in logs, returned by an API, or rendered in the Mini App.
- The engine has no inbound HTTP listener. It makes outbound connections to
  ARIA only.
- Every engine request has a device credential, timestamp, nonce, and
  request-body integrity value. Replayed, expired, malformed, or revoked
  requests are rejected.
- Telegram identity is always derived from verified `initData`; a caller
  cannot supply a different account or device identity.
- Commands are account-scoped. A user cannot read, control, revoke, or view
  events from another user or device.
- The engine starts stopped. Licence expiry, loss of a valid control session,
  an invalid command, a local configuration error, or a fatal strategy error
  stops paper activity.
- `PAPER — NO REAL ORDERS` is persistent whenever REAL-1 data is shown.
- Configuration cannot unlock a live mode. REAL-2 needs its own approved
  specification and devnet evidence before any transaction-signing code.

## 3. System topology

```text
Telegram Mini App
    | verified initData
ARIA Control Plane (Railway)
    | account-scoped commands and sanitized state
paired ARIA Engine (customer computer)
    | local only: wallet reference, RPC credential, strategy
Solana RPC
```

The control plane stores the customer account, hashed device credential,
device metadata, command records, latest sanitized state, and sanitized
event records. The engine stores its secret configuration and current paper
state locally. A public wallet address and read-only balance may be sent to
the control plane for display; neither authorizes a trade.

## 4. Customer workflow

1. The user opens ARIA from the Telegram bot and receives or restores their
   licence.
2. The Mini App presents install instructions and a single-use pairing code.
3. The user installs and starts `aria-engine` locally, then enters the code.
4. The engine exchanges the code once for a device credential and stores the
   credential with restrictive local file permissions.
5. The user configures an RPC URL and local wallet reference. Validation
   reads the public address and balance without transmitting secrets.
6. The engine sends heartbeats and sanitized state. The Mini App displays
   `CONNECTED` only from a fresh heartbeat.
7. The user saves a bounded strategy and explicitly starts paper mode.
8. The engine evaluates opportunities, emits paper events and positions, and
   receives a STOP command through the control plane.
9. The user can stop, revoke the device, or pair a replacement device.

## 5. Components and contracts

### 5.1 Local `aria-engine`

The engine is a Node.js CLI/daemon distributed as a separate package within
the repository. It has these isolated modules:

- `config`: parses a local config file, rejects unknown/unsafe values, and
  redacts sensitive values in diagnostic output.
- `license`: validates an ARIA licence against the existing public-key format
  and checks expiry before every active paper cycle.
- `pairing`: converts a single-use pairing code to a device credential and
  stores it locally.
- `rpc`: obtains chain/network identity, public wallet address, and balance;
  it never signs or broadcasts a transaction in REAL-1.
- `strategy`: validates risk limits and turns opportunities into paper-only
  decisions.
- `paper`: maintains deterministic paper orders, fills, positions, PnL, and
  an append-only local event stream.
- `control-client`: sends authenticated heartbeats/events and polls or holds
  an outbound command channel.
- `safety`: owns the irreversible local STOP latch for the process lifetime.

### 5.2 Control-plane API

The backend exposes two separate authenticated surfaces:

- Mini App API: Telegram-verified requests for pairing-code creation, device
  list/revocation, strategy reads/writes, command submission, and dashboard
  reads.
- Engine API: device-credential authenticated requests for pairing exchange,
  heartbeat submission, event submission, command acknowledgement, and
  command retrieval.

All engine-originated objects are allow-listed and size-bounded. The backend
accepts only a public address, enum state, bounded strategy summary, numeric
base-unit balance fields, and sanitized events. It rejects raw configuration,
secret-looking fields, and arbitrary log payloads.

### 5.3 Control Center

The Mini App has five real views, all sourced from backend data rather than
synthetic generators:

1. Setup: install command, pairing code, device status, and diagnostics.
2. Controls: paper start/stop and bounded strategy editor.
3. Operations: connection, RPC network, public address, and public balance.
4. Activity: reported opportunities, filter outcomes, paper orders, and
   engine events.
5. Positions: paper entry, quantity, mark, paper PnL, age, and close reason.

The unavailable state replaces all operational values with placeholders and
never retains stale activity after a disconnect.

## 6. State machines

### Device

`pairing_created -> paired -> active -> revoked`.

A pairing code is single-use, short-lived, hashed at rest, and belongs to
one Telegram account. Pairing a new device does not silently revoke an
existing one; explicit revoke is required.

### Engine and command

`stopped -> starting -> paper_running -> stopping -> stopped`.

Only `start_paper`, `stop`, and `update_strategy` exist in REAL-1. A STOP is
idempotent and wins over all other commands. The engine acknowledges each
command exactly once using a command idempotency key. A command expires if
the engine does not receive it in the defined short control window.

### Paper order

`detected -> rejected | queued -> paper_filled -> closed`.

Every transition appends a local event. Position/PnL values are explicitly
paper values. No order has a transaction signature in REAL-1.

## 7. Strategy safety bounds

The engine accepts only finite, validated values. Strategy settings include
buy amount, max open positions, maximum slippage, stop loss, TP1/TP2,
trailing stop, minimum liquidity, maximum token age, and boolean safety
filters. Bounds are defined in code and sent to the Mini App as the allowed
range, preventing the UI from claiming a setting the engine would reject.

The effective strategy is local: the engine revalidates every backend
command and applies its own licence tier limits. The backend cannot force an
out-of-range local action.

## 8. Failure handling

- Invalid, expired, or revoked device credential: backend rejects the request;
  the engine stops paper activity.
- Stale heartbeat: dashboard shows `DISCONNECTED`; no stale balance,
  positions, or events are presented as current.
- RPC error: engine records a sanitized diagnostic and stops active paper
  evaluation until the next validated RPC read.
- Licence failure: engine stops and reports `LICENSE_INVALID` without
  revealing the token.
- Backend outage: engine fails closed to stopped after its grace period and
  retains local diagnostic evidence.
- Command failure: engine emits a sanitized rejection event; it does not
  partially mutate its strategy or state.

## 9. Test and release evidence

REAL-1 is not release-ready without all of these:

- Unit tests: config redaction; licence expiry; pairing-code one-time use;
  timestamp/nonce replay rejection; command integrity; STOP precedence;
  strategy bounds; paper order transitions; no signing/broadcast import.
- Backend integration tests: forged/missing Telegram initData; account and
  device cross-access denial; pairing; revocation; replay; stale heartbeat;
  engine event validation; command idempotency.
- Engine/control-plane smoke test: a local engine pairs, reads a real chosen
  Solana RPC network and public balance, starts paper mode, posts an event,
  receives STOP, and reports stopped.
- Mini App test: actual shipped JavaScript renders setup, disconnected,
  connected-paper, stopped, and revoked-device states without generated data.
- Exact-SHA CI passes dependency installation, typecheck, all tests, and
  secret-pattern scan.
- Post-merge Railway deployment is verified at the merge SHA; `/healthz`,
  the control-plane API, and Telegram-context rendering are verified.

## 10. Explicit exclusions and successor gate

REAL-1 does not contain live transaction construction, signing, broadcasting,
DEX routing, deposits, withdrawals, custody, pooled balances, or performance
claims. It does not certify financial readiness.

REAL-2 may begin only after REAL-1 passes the release evidence above. It
requires a separate approved specification covering local transaction
construction, allow-listed programs, spend/slippage/fee limits, devnet
execution, confirmation/restart recovery, security review, and an explicit
mainnet launch gate.
