# ARIA REAL-1 customer setup

REAL-1 is a non-custodial paper-trading beta. The local ARIA Engine reads a
Solana network and public balance, evaluates paper opportunities, and reports
state to the Telegram control center. It does not sign or broadcast a
transaction. The private key, seed phrase, wallet file, and RPC credential
stay on the customer's computer.

## Requirements

- Node.js `>=22.13.0`
- An ARIA licence token from the Telegram Mini App
- A local Solana public address and a local wallet reference
- An HTTPS Solana RPC URL
- Telegram access to the ARIA bot

## Install

From the repository checkout:

```powershell
cd engine
npm install
```

Create local environment values. Do not create these variables in Railway:

```powershell
$env:ARIA_ENGINE_API_URL = "https://<aria-control-plane-domain>"
$env:ARIA_ENGINE_RPC_URL = "https://api.devnet.solana.com"
$env:ARIA_ENGINE_WALLET_REF = "os-keystore://aria/default"
$env:ARIA_ENGINE_PUBLIC_ADDRESS = "<your-public-solana-address>"
$env:ARIA_ENGINE_LICENSE = "ARIA1.<your-license-token>"
$env:ARIA_ENGINE_NETWORK = "solana-devnet"
$env:ARIA_ENGINE_MODE = "paper"
$env:ARIA_ENGINE_VERSION = "0.1.0"
$env:ARIA_LICENSE_PUBLIC_X = "<public-key-from-ARIA-setup>"
```

`ARIA_ENGINE_PUBLIC_ADDRESS` is display/read-only data. It is not a signing
authority. `ARIA_ENGINE_WALLET_REF` is an OS-keystore or local wallet
reference; it is never the private key itself.

## Pair

1. Open the ARIA Mini App inside Telegram.
2. Select **CREATE PAIRING CODE**.
3. On the local machine run:

```powershell
npx tsx src/cli.ts pair --code <one-time-code>
```

The command prints only a device ID and stores the credential in the local
`ARIA_ENGINE_CREDENTIAL_FILE` with restrictive permissions. Never paste the
credential into Telegram or a support ticket.

## Diagnose and run paper mode

```powershell
npx tsx src/cli.ts doctor
npx tsx src/cli.ts start-paper
```

`doctor` reports network, slot, public address, public balance, licence
status, and redacted configuration. It does not print secrets. In Telegram,
the control center must show `CONNECTED` and `PAPER — NO REAL ORDERS` before
paper activity is considered available.

## Stop and revoke

Use **STOP** in Telegram to send the account-scoped stop command. The local
engine also stops on licence expiry, stale control, RPC failure, malformed
commands, or a fatal strategy error. The local safety latch is dominant for
the process lifetime.

To revoke a device, use the device controls in Telegram. A revoked device
must fail all subsequent engine requests and must be paired again before it
can report state.

## What REAL-1 does not do

There is no live mode, transaction signing, order broadcast, deposit,
withdrawal, custody, pooled balance, or real performance claim. Any future
live execution requires a separate approved REAL-2 specification and
devnet/mainnet evidence.
