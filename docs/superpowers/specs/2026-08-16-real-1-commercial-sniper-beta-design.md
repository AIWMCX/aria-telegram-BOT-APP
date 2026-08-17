# REAL-1 Commercial Sniper Beta — Design

Status: **OWNER-STANDING-APPROVED DESIGN**

Date: 2026-08-16

## 0. Decision record

REAL-1 adopts **Architecture A** as the product foundation:

- the customer runs a local `aria-engine` process on their own computer;
- ARIA's Railway backend remains the control plane, not a wallet custodian;
- Telegram is the account, pairing, configuration, control, monitoring, support, and commercial surface;
- REAL-1 is **paper execution only**;
- no private key, seed phrase, signing material, or transaction-signing capability exists in REAL-1;
- live execution requires a separate future design and release gate;
- the customer may configure a public Solana wallet address for read-only balance display, but REAL-1 does not load that wallet's private key;
- all generated/demo activity is removed from the commercial path; unknown or disconnected state is rendered as unavailable, never invented.

The existing public repository `AIWMCX/aria-telegram-BOT-APP` remains the **control-plane repository**.

The local engine is distributed from a separate **private** repository/package named `AIWMCX/aria-engine`. The existing public `AIWMCX/ARIA-Solana-Sniper` demo/lead-capture repository is not used as the production engine and must not be presented as the customer sniper product.

REAL-1 depends on FREE-1A being merged and production-verified first. Its implementation branch must start from the exact FREE-1A merge SHA, not from this design-only branch.

---

## 1. Product outcome

A customer who receives ARIA access must have an actual product to use immediately.

The successful customer journey is:

1. User opens the ARIA Telegram bot and Mini App.
2. Telegram identity resolves to an ARIA account and current product entitlement.
3. User sees exact access state, including trial expiry.
4. User downloads/installs the local `aria-engine` beta.
5. The Mini App generates a short-lived one-time pairing code.
6. The customer runs `aria-engine pair <CODE>` locally.
7. The engine generates its own local device-authentication keypair and pairs with the ARIA control plane.
8. The customer configures their own Solana RPC endpoint and a **public wallet address only**.
9. `aria-engine doctor` verifies license/access, RPC connectivity, WebSocket support, wallet readability, quote-provider reachability, clock sanity, and control-plane connectivity.
10. The Mini App changes from `ENGINE DISCONNECTED` to a real connected state using the latest signed client sync.
11. The user configures paper strategy/risk settings in Telegram or locally.
12. The user starts paper mode.
13. The engine observes real Solana activity, evaluates real opportunities, obtains real market quotes, creates paper positions only when rules pass, and reports actual observed/derived data back to the control plane.
14. Telegram displays real engine status, opportunities, rejection reasons, paper positions, PnL, and events.
15. `STOP` works from both Telegram and the local CLI. Local STOP always works even if the ARIA backend is unreachable.
16. Trial expiry or revocation prevents a new paper run and transitions a running paper session to `license_blocked` safely.

REAL-1 is commercially usable when a beta customer can install, pair, configure, run, stop, disconnect, reconnect, and understand the product without any simulated dashboard behavior.

---

## 2. What REAL-1 is and is not

### In scope

- local Node.js CLI/daemon;
- ARIA access validation;
- device pairing;
- signed client-to-control-plane synchronization;
- customer RPC configuration;
- real Solana network connectivity and slot/freshness state;
- read-only public wallet balance;
- real opportunity observation;
- real quote retrieval;
- paper-only strategy evaluation and positions;
- truthful PnL based on real quotes;
- risk/settings contract;
- local and remote STOP;
- sanitized runtime snapshots and events;
- Telegram control-center UI;
- trial/entitlement enforcement;
- installation and diagnostics workflow;
- CI and end-to-end paper-mode evidence.

### Explicitly out of scope

- loading or storing customer private keys;
- seed phrases;
- transaction signing;
- transaction construction/broadcast;
- Jito bundles;
- server-side custody;
- deposits;
- withdrawals;
- ARIA financial ledger mutation;
- delegated signer vendors;
- automatic real buys or sells;
- promises of profitability;
- fabricated safety scores, social scores, liquidity, PnL, fills, or events;
- server-side ability to bypass local STOP;
- public mainnet trading certification.

Any UI or configuration implying those out-of-scope capabilities is prohibited in REAL-1.

---

## 3. System boundary

```text
┌──────────────────────────────┐
│ Telegram / Mini App          │
│ account + control + monitor  │
└───────────────┬──────────────┘
                │ Telegram initData
                ▼
┌──────────────────────────────┐
│ ARIA Control Plane           │
│ Railway + Postgres           │
│                              │
│ account / entitlement        │
│ pairing / device identity    │
│ command queue                │
│ sanitized snapshots/events   │
└───────────────┬──────────────┘
                │ outbound HTTPS only
                │ Ed25519 device-signed sync
                ▼
┌──────────────────────────────┐
│ Local aria-engine            │
│ customer computer            │
│                              │
│ license/access gate          │
│ RPC + WS                     │
│ opportunity adapters         │
│ quote adapter                │
│ paper strategy               │
│ risk                         │
│ paper positions              │
│ local STOP                   │
└───────────────┬──────────────┘
                │ read-only chain/market requests
                ▼
┌──────────────────────────────┐
│ Solana + market data         │
└──────────────────────────────┘

NO WALLET PRIVATE KEY CROSSES ANY REAL-1 BOUNDARY.
REAL-1 DOES NOT LOAD A WALLET PRIVATE KEY AT ALL.
```

The local engine never opens an inbound internet port. It initiates outbound HTTPS/WebSocket connections only. This avoids exposing a customer's machine through port-forwarding, NAT configuration, or a public listener.

---

## 4. Repository and release architecture

### Control plane

Repository: `AIWMCX/aria-telegram-BOT-APP`

Responsibilities:

- Telegram identity;
- access/entitlement source of truth;
- pairing-code issuance;
- device public-key registry;
- signed engine sync verification;
- command ownership and queueing;
- latest sanitized engine snapshot;
- bounded recent event persistence;
- Mini App application shell and views;
- product-reality endpoint;
- support/commercial flows.

It must never import engine wallet/signing code.

### Local engine

Repository: `AIWMCX/aria-engine` (**private**).

Initial distribution form: versioned Node.js CLI/daemon package compatible with Node >=22.13.0.

Commands:

```text
aria-engine version
aria-engine pair <CODE>
aria-engine doctor
aria-engine config show
aria-engine config set <key> <value>
aria-engine start
aria-engine stop
aria-engine status
aria-engine unpair
```

The engine stores only local engine configuration and its own device-authentication private key. REAL-1 stores no trading private key because REAL-1 cannot sign transactions.

The two repositories communicate only through the versioned public control-plane protocol defined in this spec.

---

## 5. Product access and the 7-day trial

The existing legacy license token remains a compatibility credential; it is **not sufficient by itself** to define the REAL-1 commercial trial because historical `trial` configuration has represented a long-lived free license.

REAL-1 introduces a server-owned entitlement contract:

```ts
export type EngineAccessStatus =
  | "trial"
  | "active"
  | "expired"
  | "revoked";

export interface EngineEntitlement {
  product: "real-1";
  status: EngineAccessStatus;
  startsAt: string;
  expiresAt: string;
  paperExecution: boolean;
  liveExecution: false;
  maxPaperBuySol: number;
  maxPaperPositions: number;
}
```

For newly activated REAL-1 beta users:

- trial duration is exactly **7 × 24 hours** from entitlement creation;
- paper execution is enabled;
- live execution is always false;
- default beta cap is `maxPaperBuySol = 0.02`;
- default beta cap is `maxPaperPositions = 5`.

The Mini App, engine access validation, emails, and account status all read the same entitlement values.

Existing long-lived license tokens are not silently shortened. Instead, access to REAL-1 is governed by `engine_entitlements`. This preserves backward compatibility while making the commercial trial precise.

### Expiry behavior

- expired/revoked entitlement cannot pair a new engine;
- expired/revoked entitlement cannot issue `START_PAPER`;
- an already-running paper engine that learns its entitlement is expired/revoked transitions to `license_blocked` and stops opening new paper positions;
- existing paper positions remain visible and are marked frozen for observation; REAL-1 does not invent forced closes;
- local `stop` and `status` remain available regardless of entitlement.

---

## 6. Pairing and device authentication

The legacy ARIA license/API key must never become the long-lived bearer credential for every engine request.

### Pairing code

Mini App authenticated route:

```text
POST /api/engine/pairing-code
```

Requirements:

- Telegram `initData` must verify first;
- account must own an active REAL-1 entitlement;
- code is cryptographically random, human-enterable, single-use, and expires after 10 minutes;
- backend stores only a hash of the code;
- generating a new code invalidates any previous unconsumed code for that user;
- code has no authority after pairing.

Format:

```text
ABCD-EFGH-JKLM
```

### Local device identity

On `aria-engine pair <CODE>`:

1. engine generates a local Ed25519 device keypair using Node native crypto;
2. private device key is written under the ARIA local config directory with owner-only filesystem permissions where the OS supports them;
3. engine sends pairing code, device public key, engine version, platform, and a random device name to the pairing endpoint;
4. backend atomically consumes the code and binds the device public key to the Telegram user and entitlement;
5. backend returns `clientId` plus current entitlement summary;
6. no reusable bearer secret is returned.

Pair endpoint:

```text
POST /api/engine/pair
```

### Signed sync

After pairing, all engine/control-plane communication uses one authenticated synchronization call:

```text
POST /api/engine/sync
```

Request headers:

```text
X-ARIA-Client-Id
X-ARIA-Sequence
X-ARIA-Timestamp
X-ARIA-Signature
```

Canonical signature input:

```text
POST\n/api/engine/sync\n<clientId>\n<sequence>\n<timestamp>\n<sha256(body)>
```

Backend verification:

- client exists and is active;
- signature verifies against the paired device public key;
- timestamp is within 60 seconds of server time;
- sequence is strictly greater than the stored last accepted sequence;
- sequence update and snapshot/event ingestion occur in one DB transaction;
- duplicate/stale sequence is rejected without ingesting state.

The engine serializes sync calls, so one monotonic sequence is sufficient.

---

## 7. Control-plane data model

PostgreSQL is used for REAL-1 runtime/control-plane state.

### `engine_entitlements`

```text
id uuid pk
user_id fk -> users.id unique for product real-1
product text = 'real-1'
status enum trial | active | expired | revoked
starts_at timestamptz
expires_at timestamptz
max_paper_buy_lamports bigint
max_paper_positions int
created_at timestamptz
updated_at timestamptz
```

### `engine_pairing_codes`

```text
id uuid pk
user_id fk -> users.id
code_hash text unique
expires_at timestamptz
consumed_at timestamptz nullable
created_at timestamptz
```

### `engine_clients`

```text
id uuid pk
user_id fk -> users.id
device_public_key text unique
device_name text
platform text
engine_version text
status enum active | revoked
last_sequence bigint default 0
last_seen_at timestamptz nullable
paired_at timestamptz
revoked_at timestamptz nullable
```

One user may pair multiple clients later. REAL-1 UI supports one active primary client and clearly labels additional clients if they exist.

### `engine_snapshots`

One latest snapshot per client:

```text
client_id pk/fk -> engine_clients.id
schema_version int
observed_at timestamptz
received_at timestamptz
payload jsonb
```

Snapshot JSON is schema-validated before storage. It contains no secret material.

### `engine_events`

Bounded sanitized operational history:

```text
id uuid pk
client_id fk
client_event_id text
sequence bigint
observed_at timestamptz
kind text
payload jsonb
created_at timestamptz
unique(client_id, client_event_id)
```

The server keeps a finite recent history for the UI. REAL-1 default retention is 7 days or 10,000 events per client, whichever is reached first.

### `engine_commands`

```text
id uuid pk
user_id fk
client_id fk
kind enum START_PAPER | STOP | UPDATE_SETTINGS | RESYNC
payload jsonb
status enum queued | delivered | completed | rejected | expired
created_at timestamptz
expires_at timestamptz
completed_at timestamptz nullable
result jsonb nullable
```

STOP commands receive priority over every non-STOP command.

---

## 8. Engine runtime contract

```ts
export type EngineRuntimeState =
  | "unpaired"
  | "stopped"
  | "starting"
  | "running_paper"
  | "stopping"
  | "degraded"
  | "license_blocked";

export type DependencyState = "connected" | "degraded" | "offline";

export interface EngineSnapshotV1 {
  schemaVersion: 1;
  clientId: string;
  engineVersion: string;
  runtimeState: EngineRuntimeState;
  network: "solana-mainnet" | "solana-devnet";
  observedAt: string;
  lastSlot: number | null;
  rpc: DependencyState;
  websocket: DependencyState;
  quoteProvider: DependencyState;
  controlPlane: DependencyState;
  publicWallet: string | null;
  walletBalanceLamports: string | null;
  settings: PaperSettings;
  counters: EngineCounters;
  opportunities: OpportunitySummary[];
  positions: PaperPosition[];
}
```

No field may contain:

- private key bytes;
- seed phrase;
- RPC URL with embedded credentials;
- authorization headers;
- license token;
- device private key;
- raw environment variables.

---

## 9. Local configuration

REAL-1 configuration contains:

```ts
export interface EngineConfigV1 {
  controlPlaneUrl: string;
  network: "solana-mainnet" | "solana-devnet";
  rpcHttpUrl: string;
  rpcWsUrl: string;
  publicWallet: string | null;
  paper: PaperSettings;
}
```

The config file may contain an RPC URL because it is local, but logs and sync payloads must redact query strings, usernames, passwords, and provider keys.

### No wallet signer in REAL-1

There is deliberately no field such as:

```text
PRIVATE_KEY
SEED_PHRASE
KEYPAIR_PATH
WALLET_SECRET
```

Adding any such field is a scope violation and blocks REAL-1 review.

---

## 10. Real Solana observation

REAL-1 must use real chain observations, not a timer-based generator.

The first opportunity source is a `ProgramLogOpportunitySource` backed by the customer's Solana WebSocket RPC.

Initial detector scope:

- subscribe to SPL Token and Token-2022 program activity using official program identifiers from the Solana SDK/runtime dependency, not copied marketing-site constants;
- identify successful mint-initialization transactions;
- fetch the parsed transaction/account state needed to identify the mint;
- deduplicate by transaction signature + relevant instruction identity;
- record slot and observed time;
- create an `observed` opportunity only from a real chain event;
- retry quoteability for a short bounded window before rejecting `NO_ROUTE`.

The adapter boundary is:

```ts
export interface OpportunitySource {
  start(onOpportunity: (opportunity: RawOpportunity) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  health(): DependencyState;
}
```

Future Pump/Raydium/provider-specific sources plug into this interface; they are not required to make REAL-1 truthful and usable.

A Solana WebSocket log subscription can filter transactions mentioning a public key; the implementation must use separate subscriptions when multiple program identifiers are watched. This behavior must be verified against current official Solana documentation during implementation.

---

## 11. Quote and paper-fill model

REAL-1 uses a `QuoteProvider` abstraction. The initial implementation is a Jupiter quote adapter, verified against the current official Jupiter API documentation at implementation time.

```ts
export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  inputAmountBaseUnits: bigint;
  maxSlippageBps: number;
}

export interface QuoteResult {
  observedAt: number;
  inputAmountBaseUnits: bigint;
  outputAmountBaseUnits: bigint;
  priceImpactPct: number | null;
  routeAvailable: boolean;
}

export interface QuoteProvider {
  quote(request: QuoteRequest): Promise<QuoteResult>;
  health(): DependencyState;
}
```

### Paper entry

A paper buy may open only if:

- engine state is `running_paper`;
- entitlement is active;
- RPC and quote provider are not offline;
- opportunity is within configured maximum age;
- quote exists;
- quote is no older than the configured quote age threshold;
- configured paper bankroll has sufficient unreserved paper balance;
- position count is below the entitlement and local setting cap;
- mint/freeze authority policy passes when the corresponding on-chain data is available;
- global/local STOP is not asserted.

The position records the exact quote inputs, outputs, and observation time used for the simulated fill.

### Paper exit and PnL

Open paper positions are repriced using real reverse quotes. PnL is derived from those quotes and the recorded entry amount. If no fresh exit quote is available, PnL is `unavailable/stale`; it is never carried forward as if current.

No paper position can claim a real transaction signature or real fill.

---

## 12. Paper settings and risk contract

```ts
export interface PaperSettings {
  paperBankrollLamports: string;
  buySizeLamports: string;
  maxOpenPositions: number;
  maxOpportunityAgeMs: number;
  maxQuoteAgeMs: number;
  maxSlippageBps: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
}
```

REAL-1 defaults:

```text
paper bankroll       0.100000 SOL
paper buy size       0.005000 SOL
max open positions   3
max opportunity age  30 seconds
max quote age        3 seconds
max slippage         500 bps
stop loss            25%
take profit          100%
trailing stop        20%
mint authority       must be revoked
freeze authority     must be revoked
```

Entitlement caps always override looser local settings.

A setting that has no implemented data source or enforcement path must not appear in the customer UI.

---

## 13. Opportunity lifecycle

```text
OBSERVED
  -> DUPLICATE        terminal
  -> TOKEN_CHECK      
      -> REJECTED_AUTHORITY
      -> QUOTE_WAIT
          -> REJECTED_NO_ROUTE
          -> REJECTED_STALE
          -> RISK_CHECK
              -> REJECTED_STOPPED
              -> REJECTED_CAPACITY
              -> REJECTED_BANKROLL
              -> PAPER_OPENED
```

Every rejection has a machine-readable reason and a customer-safe message.

The product must show why an opportunity did not become a paper position. It must not imply that every observed mint was safe or tradeable.

---

## 14. Paper position lifecycle

```text
OPEN
  -> OPEN_STALE_PRICE
  -> EXIT_REQUESTED_TP
  -> EXIT_REQUESTED_SL
  -> EXIT_REQUESTED_TRAILING
  -> EXIT_REQUESTED_MANUAL
  -> CLOSED_PAPER
```

`OPEN_STALE_PRICE` is a display/health state, not a forced close.

Manual close in REAL-1 means “close this paper position at the next valid quote.” It never creates or signs a Solana transaction.

---

## 15. STOP semantics

STOP is a safety primitive even in paper mode because it defines the future control semantics.

### Local STOP

`aria-engine stop`:

- immediately sets local stop intent;
- prevents new paper positions before any network call;
- transitions `running_paper -> stopping -> stopped`;
- does not require backend availability;
- is idempotent.

### Telegram STOP

Mini App sends a Telegram-authenticated command:

```text
POST /api/engine/commands
{ "kind": "STOP" }
```

Backend queues STOP at highest priority. Engine receives it on the next sync and applies the same local STOP path.

### Backend cannot override local STOP

A later `START_PAPER` command cannot restart an engine while a local stop lock is asserted until the customer explicitly clears/restarts locally. This prevents a compromised control plane from silently reactivating a locally stopped engine.

---

## 16. Sync body and response

Engine request body:

```ts
export interface EngineSyncRequestV1 {
  schemaVersion: 1;
  snapshot: EngineSnapshotV1;
  events: EngineEventV1[];
  commandResults: EngineCommandResultV1[];
}
```

Backend response:

```ts
export interface EngineSyncResponseV1 {
  ok: true;
  serverTime: string;
  entitlement: EngineEntitlement;
  commands: EngineCommandV1[];
  nextSyncAfterMs: number;
}
```

Normal sync interval: **2 seconds** while the engine is running and **10 seconds** while stopped.

Maximum event batch: 100.

Command results and events are idempotent by IDs.

---

## 17. Mini App: one product, multiple views

The Mini App has one Telegram URL but is no longer one marketing/demo page. It becomes an application shell with six views.

### 17.1 Overview

Shows:

- ARIA account status;
- trial/paid access and exact expiry timestamp;
- engine connected/disconnected/stale;
- engine version;
- network;
- RPC health;
- quote-provider health;
- public wallet address;
- real read-only SOL balance;
- paper bankroll;
- runtime state;
- prominent `START PAPER` or `STOP` control.

### 17.2 Sniper

Shows:

- live observed opportunities;
- timestamp and age;
- mint;
- source;
- quoteable/not quoteable;
- authority checks;
- risk decision;
- rejection reason;
- paper-open result.

No opportunity appears unless a real engine event produced it.

### 17.3 Positions

Shows only paper positions in REAL-1:

- explicit `PAPER` badge on every position;
- mint/symbol if available;
- entry quote time;
- paper size;
- current quote time/freshness;
- current quoted value;
- unrealized PnL or `STALE/UNAVAILABLE`;
- age;
- exit trigger state;
- manual paper-close action.

### 17.4 Activity

Chronological real engine/control events:

- connected/disconnected;
- opportunity observed;
- rejected reason;
- paper opened;
- paper closed;
- RPC degraded/recovered;
- quote provider degraded/recovered;
- settings applied/rejected;
- STOP received/applied;
- entitlement blocked.

No random/generated feed exists.

### 17.5 Settings

Only settings implemented by the engine are shown.

Edits are submitted as versioned `UPDATE_SETTINGS` commands. UI shows pending/applied/rejected state; it does not optimistically pretend a setting was applied before engine acknowledgement.

### 17.6 Account / Install

Shows:

- entitlement plan/status;
- trial start/expiry;
- engine installation instructions;
- generate pairing code;
- paired device(s);
- revoke device;
- engine version/update status;
- diagnostics checklist;
- support link;
- renewal/upgrade surface when commercial billing is intentionally enabled.

The legacy “get license” form is not the application home after the user has access.

---

## 18. Mini App stale/disconnected truth rules

The browser never infers that an engine is alive merely because an old snapshot exists.

State rules:

- `CONNECTED`: latest verified engine sync <= 6 seconds old;
- `STALE`: > 6 seconds and <= 30 seconds old;
- `DISCONNECTED`: > 30 seconds old or no snapshot;
- `UNAVAILABLE`: API failure or invalid snapshot.

When stale/disconnected/unavailable:

- no synthetic activity starts;
- position quote ages continue increasing visibly;
- PnL is marked stale when the underlying quote is stale;
- START is disabled if the backend cannot prove an active client and entitlement;
- STOP remains queueable for a known client, and UI clearly indicates whether delivery is pending.

---

## 19. Product reality after REAL-1

FREE-1A remains the truth foundation.

After REAL-1 implementation has real code-backed integrations and verification:

```ts
CURRENT_PRODUCT_CAPABILITIES = {
  liveData: true,
  paperExecution: true,
  devnetExecution: false,
  mainnetExecution: false,
};
```

Important semantic distinction:

- `dataMode: live` means displayed engine/chain/quote information comes from real integrations, not simulated generators;
- `executionMode: paper` means positions/fills are simulations based on real observed data and real quotes;
- it does **not** mean a Solana transaction was executed.

REAL-1 production configuration may therefore become:

```text
ARIA_PRODUCT_ENVIRONMENT=production
ARIA_NETWORK_MODE=solana-mainnet
ARIA_DATA_MODE=live
ARIA_EXECUTION_MODE=paper
ARIA_CONTROL_STATE=stopped
```

The per-customer engine runtime state remains separate from the global product-reality contract.

---

## 20. Security controls

### Secrets

Never transmit or log:

- wallet private keys;
- seed phrases;
- keypair files;
- device private key;
- full ARIA legacy license token;
- RPC credentials or API keys;
- environment dumps.

### Telegram writes

Every Mini App state-changing route:

1. validates request schema;
2. verifies Telegram `initData`;
3. resolves canonical user;
4. validates current entitlement;
5. validates ownership of target client;
6. applies command-specific state rules;
7. records an audit entry.

### Engine writes

Every sync:

1. validates size limit before JSON parsing where supported;
2. validates schema version and exact shape;
3. verifies paired device signature;
4. verifies timestamp;
5. verifies monotonic sequence;
6. sanitizes/redacts payload fields;
7. stores snapshot/events transactionally;
8. updates last_seen only after authentication succeeds.

### Browser

The browser is never a trusted authorization source. Hiding or disabling a button is UX only; server and engine enforce all rules again.

### Dependency failure

Unknown dependency health denies new paper entries. Failure does not become a successful trade, green health state, or fabricated price.

---

## 21. Error handling

### RPC unavailable

- engine becomes `degraded`;
- no new opportunities are admitted;
- no new paper entries open;
- existing positions display stale prices;
- reconnect uses bounded exponential backoff;
- local STOP remains immediate.

### WebSocket unavailable but HTTP RPC healthy

- opportunity detector becomes offline;
- balance/status may remain readable;
- UI identifies detector failure separately;
- no fake opportunities.

### Quote provider unavailable

- opportunities may remain observed but are rejected `QUOTE_UNAVAILABLE` after the bounded quote window;
- no paper entry opens;
- open position PnL becomes stale/unavailable.

### Control plane unavailable

- local paper engine may continue for at most 120 seconds from last valid entitlement sync;
- after 120 seconds without control-plane validation, it stops opening new paper positions and enters `degraded`;
- local STOP/status continue;
- snapshots/events buffer locally with a strict bounded queue and resend idempotently after reconnect.

### Clock skew

`doctor` fails if local clock skew prevents signed sync acceptance. Runtime identifies `CLOCK_SKEW` instead of retrying indefinitely.

---

## 22. Local bounded persistence

REAL-1 needs crash recovery for paper state but not a financial ledger.

Local storage under the ARIA config directory contains:

- device identity;
- sanitized engine config;
- current paper session state;
- open paper positions;
- last accepted settings version;
- last engine event sequence;
- bounded unsent event buffer.

Atomic file replacement or a small local SQLite database may be used; implementation plan chooses one based on existing dependencies. No financial/custody semantics are claimed for this store.

On restart:

- engine starts `stopped`;
- it restores open paper positions for display/repricing;
- it does not auto-start strategy execution merely because it was previously running.

---

## 23. Observability

### Engine logs

Structured logs with:

- timestamp;
- level;
- subsystem;
- event code;
- client/event IDs when safe;
- no secret values.

Required event codes include:

```text
ENGINE_START
ENGINE_STOP
PAIR_SUCCESS
PAIR_REJECTED
RPC_CONNECTED
RPC_DEGRADED
WS_CONNECTED
WS_DEGRADED
QUOTE_CONNECTED
QUOTE_DEGRADED
OPPORTUNITY_OBSERVED
OPPORTUNITY_REJECTED
PAPER_POSITION_OPENED
PAPER_POSITION_CLOSED
SETTINGS_APPLIED
SETTINGS_REJECTED
ENTITLEMENT_BLOCKED
SYNC_ACCEPTED
SYNC_REJECTED
```

### Control-plane metrics

At minimum:

- paired clients;
- connected/stale/disconnected clients;
- sync authentication failures;
- command queue latency;
- command rejection count;
- opportunity/event ingestion volume;
- API 4xx/5xx rates.

---

## 24. Installation and diagnostics UX

The beta installation experience must be explicit and reproducible.

Minimum documented sequence:

```text
1. Install Node >=22.13
2. Install the versioned ARIA engine package
3. aria-engine version
4. Generate pairing code in Telegram
5. aria-engine pair ABCD-EFGH-JKLM
6. aria-engine config set rpcHttpUrl <customer RPC HTTPS URL>
7. aria-engine config set rpcWsUrl <customer RPC WSS URL>
8. aria-engine config set publicWallet <public Solana address>
9. aria-engine doctor
10. aria-engine start
```

`doctor` prints PASS/FAIL for:

- engine version;
- config file permissions;
- device identity;
- control-plane pairing;
- entitlement status/expiry;
- local/server clock skew;
- HTTP RPC connectivity;
- WebSocket RPC connectivity;
- network/chain identity;
- public wallet lookup;
- quote-provider reachability.

It never prints full secret-bearing URLs.

---

## 25. Testing strategy

REAL-1 is not accepted by visual inspection alone.

### Engine unit tests

- configuration validation;
- redaction;
- entitlement state transitions;
- opportunity dedupe;
- risk gate ordering;
- paper bankroll reservation/release;
- paper entry/exit math in integer base units;
- stale quote behavior;
- STOP idempotency;
- restart starts stopped;
- no signer/private-key configuration accepted.

### Engine integration tests

- mocked RPC/WS events produce deterministic opportunities;
- quote adapter fixtures produce deterministic paper positions;
- disconnect/reconnect;
- event buffer replay exactly once;
- command execution and result acknowledgement;
- expired entitlement blocks start;
- local STOP without backend.

### Control-plane tests

- pairing code ownership/expiry/single-use;
- device signature success/failure;
- sequence replay rejection;
- cross-user client isolation;
- entitlement enforcement;
- command ownership;
- STOP priority;
- snapshot secret-field rejection;
- stale/disconnected derivation;
- API response schema.

### Shipped Mini App runtime tests

Execute actual shipped frontend JavaScript against deterministic scenarios:

- no account;
- account/trial active, no engine;
- pairing code generated;
- connected stopped engine;
- running paper engine;
- real opportunity event;
- paper position;
- stale snapshot;
- disconnected engine;
- invalid/malformed API response;
- entitlement expired;
- STOP pending/applied;
- settings pending/applied/rejected.

No test may reconstruct the behavior instead of executing the shipped handler.

### External paper-mode smoke test

With a real Solana RPC and public wallet:

- `doctor` passes;
- engine receives real slots;
- real wallet SOL balance matches independent RPC lookup;
- at least one real opportunity is observed or the detector runs for a documented observation window with no fabricated event;
- quote adapter returns a real route for a known routable mint fixture/current token;
- paper position can be opened from a real quote fixture/live quote path without signing;
- Telegram reflects the signed engine snapshot;
- STOP propagates and engine stops admitting new paper positions.

---

## 26. Commercial truth rules

Allowed REAL-1 claims:

- “Real Solana data” only after runtime evidence proves the integration;
- “Paper trading”;
- “Local engine”;
- “Your wallet key stays with you” because REAL-1 does not load the key;
- “Telegram control center”;
- “7-day beta trial” when entitlement is actually 7 days.

Prohibited REAL-1 claims:

- “live trading”;
- “mainnet execution”;
- “autonomous real trades”;
- “custody”;
- “guaranteed profit”;
- “risk-free”;
- fake historical win rate;
- fake latency/transaction success metrics;
- any safety filter not actually implemented and enforced.

---

## 27. Five-hour bounded build target

The “five hours” target is interpreted as an aggressive **REAL-1 engineering sprint**, not permission to skip evidence gates.

The implementation order is:

### R1 — Engine skeleton + access + pairing

- private `aria-engine` repo/package;
- CLI;
- local device key;
- config;
- `doctor` skeleton;
- pairing code + `/api/engine/pair`;
- signed `/api/engine/sync`;
- entitlement contract.

### R2 — Real read-only Solana runtime

- HTTP RPC health;
- WebSocket health;
- slot freshness;
- public wallet balance;
- sanitized snapshot sync.

### R3 — Real opportunity + quote + paper engine

- token-program opportunity source;
- dedupe;
- quote adapter;
- risk gates;
- paper positions/PnL;
- local STOP;
- crash-safe paper state.

### R4 — Control commands + application UI

- command queue;
- START_PAPER;
- STOP;
- UPDATE_SETTINGS;
- Overview/Sniper/Positions/Activity/Settings/Account views;
- no simulator.

### R5 — Verification and beta packaging

- full tests;
- secret-pattern scan;
- exact-SHA CI in both repos;
- package artifact with SHA256;
- Railway control-plane deployment only after FREE-1A release closure;
- real RPC smoke test;
- Telegram Mini App evidence;
- beta install instructions.

If the five-hour sprint ends before all gates pass, the result is explicitly `PARTIAL`; no live-execution scope is added to compensate.

---

## 28. Acceptance criteria

REAL-1 is complete only when all are true:

1. FREE-1A is merged and its exact merge SHA is verified in production.
2. Control plane and engine each have exact-SHA green CI.
3. Engine package is versioned and reproducibly installable.
4. Customer can pair without pasting a private wallet key anywhere.
5. Device sync signature and replay controls are verified.
6. Trial entitlement is exactly represented in Mini App and enforced by engine/control plane.
7. Real RPC health, slot, and read-only wallet balance are proven.
8. Opportunities derive from real Solana observations, not timers/random generators.
9. Paper fills/PnL derive from real quote responses or explicitly marked fixtures in tests.
10. Live execution is technically impossible in the shipped REAL-1 engine.
11. Local STOP works with control plane offline.
12. Telegram STOP works end to end.
13. Stale/disconnected engine state never appears connected/live.
14. No secret-bearing field is accepted in engine snapshots.
15. Mini App has the six application views and no marketing/demo page is the primary authenticated experience.
16. Production smoke evidence shows one real paired engine reflected in Telegram.
17. No P0/P1 security finding remains open.
18. Rollback SHAs and package rollback version are recorded.

---

## 29. Rollback

Control plane:

- rollback to the last known-good Railway deployment SHA;
- REAL-1 migrations are additive and must remain backward compatible with a rolled-back server;
- disable engine pairing/commands with a server feature flag if needed.

Engine:

- customer installs the prior signed/versioned package;
- backend may revoke a problematic engine version from new pairing/start while continuing to accept STOP/status sync long enough for safe migration.

No rollback path may enable live execution.

---

## 30. Deferred follow-up releases

### REAL-2 — Paper beta hardening

- more opportunity sources;
- deeper token/liquidity intelligence;
- strategy evaluation quality;
- multi-device management;
- update channel;
- richer support diagnostics;
- retention/activation analytics.

### LIVE-1 — Local signer and transaction execution design

Separate owner-approved design required before any code can load a wallet private key or sign a transaction. It must cover:

- local signer abstraction;
- exact transaction construction;
- simulation/preflight;
- program allowlists;
- spend limits;
- idempotency;
- transaction uncertainty/recovery;
- priority fees/Jito decision;
- live position reconciliation;
- kill switches;
- mainnet tiny-value beta gates.

### HOSTED-1 — Server-hosted/delegated authority

Remains governed by the separate custody/ledger/reconciliation/withdrawal/delegated-signer program. REAL-1 does not shortcut or supersede it.

---

## 31. Permanent release gate

REAL-1 follows:

```text
design
→ implementation plan
→ red/green TDD
→ independent review
→ exact-SHA CI
→ package/deploy exact SHA
→ real runtime evidence
→ Telegram customer-flow evidence
→ completion declaration
```

A visually impressive dashboard is not completion. A license is not completion. A successful Railway deploy is not completion. REAL-1 is complete only when the customer-local engine and Telegram control plane work together against real Solana data in paper mode under the acceptance criteria above.
