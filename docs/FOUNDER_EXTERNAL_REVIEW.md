# Founder external wallet review — implementation, not production evidence

This change adds a disabled-by-default panel to the repository's reference
frontend (`public/index.html`). It does not modify the private ARIA engine,
place trades, construct transactions, connect a wallet, or accept wallet secrets.
The existing PAPER engine and dashboard remain PAPER-only.

## Enable after review

Configure the control-plane deployment:

- `ARIA_EXTERNAL_REVIEW_ENABLED=true`
- `ARIA_EXTERNAL_REVIEW_FOUNDER_ID=<founder's positive Telegram user ID>`
- `ARIA_EXTERNAL_REVIEW_RPC_URL=<HTTPS mainnet RPC endpoint>`

Keep RPC credentials in deployment secrets. The endpoint is never returned to
the browser. Existing Telegram HMAC authentication is required, with a stricter
one-hour age and future-date check for this panel. Only the configured founder
can access its API. Requests are limited to 10/minute/process and one verification
in flight per process. This is a single-founder test, not a distributed public
service. Disable by setting the enable flag to `false`.

Open a fresh Telegram session pointing at this deployment's reference frontend.
The panel appears only after authenticated status succeeds. If BotFather points
at appss.pro instead, this patch alone will not change that external frontend.
Do not claim deployment or device compatibility until verified there.

## Workflow

1. Copy the exact candidate mint from ARIA's existing analysis into the panel.
   This initial slice uses manual selection; it does not prove signal provenance.
2. Generate an official `https://jup.ag/` link with `buy`/`sell` mint parameters.
   The amount is deliberately not prefilled: no documented amount parameter was
   verified. Check both token addresses, amount, fees and slippage on Jupiter.
3. Open Jupiter in a wallet-compatible browser if Telegram cannot connect Trust
   Wallet. Any approval and submission are performed by the founder outside ARIA.
   Mobile/desktop Trust Wallet compatibility still requires physical-device testing.
4. Paste the public wallet address and resulting public transaction signature.
5. ARIA uses only `getGenesisHash` and `getTransaction` at `finalized` commitment.
   It reports exact integer token and native SOL deltas and the transaction's
   network fee. `maxSupportedTransactionVersion: 0` deliberately fails closed on
   newer formats; unsupported transactions are not silently interpreted.

The external link cannot enforce a spend cap, slippage cap, or daily loss limit.
A single successful transaction is not a stress test or proof of strategy edge.
No automatic Jupiter callback is implemented; signature entry is manual.

## Meaning of verification

- Require the mainnet genesis hash, a successful finalized transaction, exact
  signature match, expected wallet as a transaction signer, expected token
  metadata, complete native balances and safe integer numeric values.
- Token amounts use integer strings/BigInt, never floating UI amounts.
- Aggregate expected token balances across accounts owned by the expected wallet.
- Missing metadata, wrong wallet/mint, RPC errors and unsafe numbers fail closed.
- `null` at finalized commitment means not found OR not finalized, not failure.
- Public signatures do not prove that the submitting Telegram user owns a wallet.
- Balance changes do not alone prove Jupiter swap provenance. The result is
  explicitly a **finalized balance observation**, not a verified swap.

## P&L is intentionally unavailable

Native SOL movement can include rent deposits/refunds, unrelated transfers,
wrapped SOL and tips. A network fee is already included in the fee payer's
native balance change: do not subtract it twice. Network fee is not total trading
cost. `realizedPnlLamports` is null, never a fabricated zero or gain.

Before reporting realized P&L, add instruction/provenance validation and a durable
entry/exit ledger with unique signatures, exact mint and lot matching, partial
exit allocation, wrapped-SOL/rent reconciliation, fee attribution and external
transfer classification. Unreconciled cases must remain unavailable. This PR
makes no promise of a profitable trade or complete P&L support.

## Validation and release gate

- Run `npm run typecheck` and `npm test` in CI (Node 22).
- Synthetic tests exercise precision, failed/incomplete transactions, signer and
  mint mismatch, mainnet identity, finalized lookup, disabled/unauthorized access,
  missing configuration, strict request bodies and rate limiting.
- Verify the actual Telegram -> Jupiter -> Trust Wallet -> ARIA path manually.
- Read back a founder-chosen existing finalized transaction first, before any
  real-money test. Confirm values against an independent explorer.
- No production enablement, external trade, or mainnet smoke is implied by tests.

References checked 2026-10-21:
- https://solana.com/docs/rpc/http/gettransaction
- https://jup.ag/?buy=2Fob54QUhUbP9jv6h5XAh3PgB1kcULR6LXbxSzuwpump&sell=So11111111111111111111111111111111111111112
  (observed official mint-link format; not an endorsement of this token).
