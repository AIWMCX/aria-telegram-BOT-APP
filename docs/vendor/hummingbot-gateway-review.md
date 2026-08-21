# Hummingbot Gateway review — REAL-2 PR-1

**Review date:** 2026-08-20
**Upstream:** https://github.com/hummingbot/gateway
**Pinned release candidate:** `v2.16.0`
**Pinned upstream commit:** `f090f4ab7a8159b85fca2f3d4467970a5231cf5f`
**License:** Apache-2.0
**Review status:** **not approved for wallet or execution integration**

## Scope and decision

This review supports a local, loopback-only health boundary in ARIA. It does not add Gateway as a dependency, install it, start it, provision a wallet, request a quote, construct a transaction, sign, or broadcast.

Gateway may be reconsidered as a local execution sidecar only after an ARIA-owned signer/policy design prevents ARIA from reaching the upstream wallet routes and verifies every transaction before any signing operation. The upstream product is not an ARIA custody component.

## Code inspected at the pinned commit

- `src/connectors/jupiter/router-routes/quoteSwap.ts`
- `src/connectors/jupiter/router-routes/executeSwap.ts`
- `src/chains/solana/solana.ts`
- `src/wallet/utils.ts`
- `src/services/config-manager-cert-passphrase.ts`
- `src/templates/server.yml`

## Positive evidence

- Upstream declares Apache-2.0 licensing.
- `v2.16.0` release notes report wallet-hardening work, loopback bind work, opt-in API authentication and rate limiting.
- The repository contains Solana, Jupiter, Raydium, Meteora and Orca connector code.
- Jupiter quote responses preserve some router quantities as strings (`inAmount`, `outAmount`, `otherAmountThreshold`), which is useful input for a later ARIA integer-only policy layer.
- The server template documents an IP allowlist with localhost allowed by default.

## Blocking security findings

1. `src/wallet/utils.ts` accepts `req.privateKey` in `addWallet()`. It must never be invoked, proxied, or made reachable from ARIA.
2. The same upstream error path interpolates the first characters of `req.privateKey` into an error message. ARIA must not rely on that route or its logs.
3. `ConfigManagerCertPassphrase.readPassphrase()` accepts a passphrase from an argument or `GATEWAY_PASSPHRASE`. That does not meet ARIA’s future local-keystore policy by itself.
4. Jupiter `execute-swap` obtains a fresh quote and immediately invokes execution. That bypasses ARIA’s required durable order state machine and transaction-policy inspection gate.
5. Jupiter quote code uses JavaScript `number`, `Math.pow`, `Math.floor`, and `parseFloat` for human-facing quote calculations. ARIA must preserve bigint/integer accounting at its own policy boundary and must not use Gateway output as an uninspected authorization.
6. The template allowlist alone is not proof of an actual loopback listener; ARIA must enforce a loopback HTTPS endpoint at runtime and test it.

## Allowed PR-1 interaction

ARIA’s `HummingbotGatewayExecutionAdapter` is a zero-signing `LiveExecutionPort` implementation. It accepts only `https://127.0.0.1`, `https://localhost`, or `https://[::1]` endpoints and calls only an injected readiness probe. It has no wallet, quote, transaction, signing, sender, or broadcast methods.

## Deliberately not used

- Gateway wallet creation/import/remove/sign-message routes
- Gateway passphrase configuration as an ARIA keystore
- Jupiter `execute-swap` and any router execution route
- Raydium/Meteora/Orca execution routes
- Jito, priority-fee sending, transaction broadcast, or public Gateway binding
- `latest` tags or unpinned upstream dependencies

## Upgrade policy

Any future Gateway evaluation must pin a tag and immutable commit, repeat this source review, rerun dependency/license/security checks, and require a dedicated PR. No automatic upstream upgrade is permitted.

## Next required gate

Before a PR can add a signer, transaction inspection, or dry-run build path, ARIA needs a separate approved threat model covering a local keystore, OS credential storage, secret lifecycle, policy parsing, simulation, reconciliation, and a fail-closed emergency stop. Mainnet broadcast is out of scope.
