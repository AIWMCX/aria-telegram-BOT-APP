# CLAUDE.md — ARIA Terminal Backend

Context file for Claude Code (or any future session picking this up). Read this
before touching anything.

## What this is

Backend for **ARIA Sniper Terminal**, a paid Solana memecoin sniper distributed
via Telegram. This repo is the **API + license issuer + payment processor**.
It is NOT the sniper itself (that's a separate TypeScript repo,
`sniper-solana` / `C:\solana-sniper`) and it is NOT the primary Mini App UI
(that's currently being built in appss.pro, a third-party no-code Telegram
Mini App builder — see "Two frontends" below).

## Two frontends — know which one you're editing

1. **`public/index.html`** in this repo — a fully working reference
   implementation. Terminal demo, pricing, trial form, Stripe checkout. This
   is what Railway serves at `PUBLIC_URL`. It's the fallback / source of
   truth for what the product should look and behave like.
2. **appss.pro Mini App** — a separately hosted no-code build the business
   owner (Bogdan) is iterating on for the actual customer-facing UI. We have
   no code access to it. If asked to "fix a bug in the Mini App," clarify
   which frontend is meant — if it's the appss.pro one, we likely can't
   touch it directly; the fix belongs in `public/index.html` and gets
   ported over manually, or appss.pro's form gets pointed at this repo's
   API endpoints (`/api/submit`, `/api/checkout`).

**The API in this repo (`/api/*`) is the shared backend either frontend should call.**

## Architecture in one paragraph

Telegram Mini App (either frontend) collects name/email/wallet, POSTs to
`/api/submit` (trial) or `/api/checkout` (paid) with Telegram's signed
`initData` attached. The backend verifies that HMAC (`telegram-auth.ts`) —
this is the only thing standing between us and anyone spamming the lead
database. On success, a license is issued: an Ed25519-signed, offline-
verifiable token (`license-signer.ts` + `licenses.ts`) written to SQLite
and emailed via Resend. Stripe handles recurring billing for Standard/Pro;
webhooks (`stripe.ts`) re-issue licenses on renewal and cancel subscriptions
on churn. Everything writes to `audit_log` — nothing is silently mutated.

## File map

```
src/
  config.ts          Zod-validated env, tier definitions (trial/standard/pro caps)
  db.ts               SQLite connection + full schema (5 tables)
  audit.ts            Insert-only audit log helper — call this on every state change
  leads.ts            Lead upsert/lookup, rate-limit check
  license-signer.ts   Ed25519 sign/token format — the crypto core, keep this file small and boring
  licenses.ts         Issues + revokes licenses, ties signer to DB + tier config
  engine-entitlement-signer.ts  ARIAE1 token issuer for the ARIA engine product (separate keypair from
                       license-signer.ts — see ARIA_ENTITLEMENT_PRIVATE_D/_X in .env.example). The only
                       file allowed to hold that private key.
  engine-entitlements.ts        Postgres storage for engine entitlements (trial/active/expired/revoked) —
                       storage only, never signs anything itself
  orders.ts           Stripe order tracking (pending → paid → refunded)
  subscriptions.ts    Stripe subscription state mirror (getSubscriptionByCustomerId maps a Stripe customer -> lead, used for refund auto-revocation on ANY charge, not just the first)
  telegram-auth.ts    initData HMAC verification — DO NOT weaken this
  stripe.ts           Checkout session creation + webhook dispatch (charge.refunded now auto-revokes)
  expiry-warnings.ts  7d/1d license-expiry DM scheduler, started from index.ts
  email.ts            Resend — lead notification + license delivery templates
  bot.ts              grammy bot — /start /license /status (status view, no key entry) /licensekey (advanced, raw token) /support, admin /stats /revoke /revokeengine
  server.ts           Hono routes — this is the API surface, start here to understand data flow
  index.ts            Entrypoint — boots DB, server, bot
scripts/
  generate-keys.ts    Run once: `npm run keygen` — outputs the Ed25519 keypair for .env
public/
  index.html          Reference frontend (see "Two frontends" above)
```

## What's DONE (as of this handoff)

- [x] Trial signup end-to-end: form → initData verify → lead saved → license issued → email + Telegram DM
- [x] Stripe checkout session creation for Standard/Pro
- [x] Stripe webhook handling: `checkout.session.completed`, `invoice.paid` (renewal), `customer.subscription.deleted`, `charge.refunded` (auto-revokes the active license — commit `a74d79a`, keyed off `customer` id via `getSubscriptionByCustomerId()` so it correctly handles a refund on a renewal charge too, not just the first payment; the `orders.status` field itself is NOT updated on refund — renewals never get an `orders` row to update, and matching the wrong order via a heuristic would be worse than leaving it as a known, disclosed limitation)
- [x] 7-day / 1-day license-expiry warning DMs (`expiry-warnings.ts`, started from `index.ts`, commit `a74d79a`) — `warned_7d`/`warned_1d` columns added via a defensive `ALTER TABLE` in `db.ts` (no migration framework exists; this guards against re-running on an already-deployed DB missing the columns)
- [x] License system: Ed25519 signing via Node's native `crypto` (no external dep), wallet-bound, offline-verifiable
- [x] Rate limiting (3 submissions/hour/Telegram user)
- [x] Audit log on every mutation
- [x] Admin bot commands: `/stats`, `/revoke <license_id>`
- [x] Zero TypeScript errors, verified with `npx tsc --noEmit` (re-verify after this reconstruction — see note below)
- [x] ARIA engine (separate product, `AIWMCX/aria-engine`) Telegram `/pair` flow + ARIAE1 entitlement
      issuance at `/api/engine/pair` (commit `c7e7f1c`, CI green) — the engine consumes and offline-verifies
      the token, including a real `aria paper start` enforcement gate (`aria-engine` commits `651b098`,
      `146ff2e`). Revocation before natural 7-day expiry is NOT yet enforced (needs the sync-protocol
      upgrade below); this is otherwise the ARIA engine's full commercial entitlement loop, separate from
      this repo's original license/Stripe product above.

## Reconstruction note (read this first)

This project was rebuilt in this Claude Code session from a set of files pasted
in, downloaded from a *different* Claude session/sandbox.
Every file's content had been shifted one position relative to its filename in
that paste (a rotation, not random corruption) — e.g. the file saved as `bot.ts`
actually contained `licenses.ts`'s code. Each file below was re-identified by its
actual imports/exports and written to its correct path. Four files could not be
recovered from the paste at all (the rotation consumed their slots) and were
**authored fresh** based on what the code imports: `package.json`, `tsconfig.json`,
`.env.example`. `package-lock.json` is intentionally not carried over — regenerate
it with `npm install`.

**Do not assume this compiles or runs until `npm install && npm run typecheck`
has actually been run in this repo.** The individual files are internally
consistent (correct imports resolve to files that actually export those names),
but the full pipeline has not yet been exercised end-to-end since reconstruction.

## What's NOT done — known gaps, pick these up next

- [x] ~~`charge.refunded` webhook doesn't auto-revoke the license~~ — **closed, commit `a74d79a`.** See "What's DONE" above. Real, remaining limitation: `orders.status` itself isn't updated to `refunded` (only the license is revoked), since a renewal refund has no `orders` row to update at all and there's no reliable way to pick the "right" order for a refund on the initial purchase either without adding payment_intent tracking the current schema doesn't have.
- [x] ~~No automated expiry warnings~~ — **closed, commit `a74d79a`.** See "What's DONE" above.
- [ ] **No crypto (SOL/USDC) payment path.** Spec section 5.2 describes a
      memo-based on-chain verification flow. Not built. Only Stripe exists
      right now.
- [ ] **No admin dashboard.** All inspection is via `sqlite3` CLI or the
      `/stats` bot command. A simple read-only `/admin` HTTP route with
      basic auth would go a long way.
- [ ] **License client verification lives in a DIFFERENT repo**
      (`sniper-solana`). This backend only *issues* licenses. The sniper
      itself needs a `src/license.ts` that verifies the Ed25519 signature
      using `ARIA_LICENSE_PUBLIC_X` (same value, baked in as a constant, not
      an env var, since the client is distributed to customers). That file
      does not exist yet as of this handoff — go build it in the sniper
      repo when this backend is confirmed working.
- [ ] **`public/index.html` is a reference implementation, not necessarily
      the live customer-facing surface.** Confirm with Bogdan whether
      appss.pro or this HTML is the surface being promoted before doing UI
      polish work here.
- [ ] **`.env` was never actually filled in and deployed successfully on
      Railway as of this handoff** — a prior deploy attempt failed
      (suspected missing `PUBLIC_URL`/`ADMIN_EMAIL` or no volume mounted).
      Verify a clean deploy end-to-end before building further features.
- [ ] **`$rypto$`-AIWMC entity separation is not confirmed complete.** See
      "Stripe setup" below — this is a hard blocker on going live with paid
      tiers, per explicit owner instruction, not a code issue.

## Deploy checklist (do this first, in order)

1. `npm install`
2. `npm run keygen` → copy the two output values
3. `cp .env.example .env` → fill in every value (Stripe vars can stay blank for now)
4. `npm run typecheck` → must be zero errors before deploying
5. `npm run dev` locally, use `ngrok http 8080` for a public HTTPS tunnel (Telegram Mini Apps require HTTPS)
6. Push to GitHub, connect the repo in Railway
7. In Railway: **Settings → Volumes** → mount `/data` (SQLite needs this to survive redeploys)
8. In Railway: **Variables** → paste every var from `.env` (use the SAME `ARIA_LICENSE_PRIVATE_D`/`_X` you generated — do not re-run keygen on Railway, or old licenses stop verifying)
9. In Railway: **Settings → Networking** → Generate Domain → copy into `PUBLIC_URL` var
10. Redeploy, check `/healthz` returns `{"ok":true,...}`
11. @BotFather → set the Mini App menu button URL to `PUBLIC_URL`
12. Test: `/start` in Telegram → open terminal → submit trial form → confirm email arrives

## Stripe setup (when ready to charge money)

1. Create two Products in Stripe Dashboard: "ARIA Standard" ($149/mo recurring), "ARIA Pro" ($449/mo recurring)
2. Copy their `price_...` IDs into `STRIPE_STANDARD_PRICE_ID` / `STRIPE_PRO_PRICE_ID`
3. `STRIPE_SECRET_KEY` from Dashboard → Developers → API keys
4. Webhook: Dashboard → Developers → Webhooks → Add endpoint → `{PUBLIC_URL}/api/webhook/stripe` → select events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `charge.refunded` → copy signing secret into `STRIPE_WEBHOOK_SECRET`
5. Test locally with `stripe listen --forward-to localhost:8080/api/webhook/stripe`
6. **Do not go live until the $rypto$-Telegram entity separation from AIWMC LLC is complete** — this is a hard business/legal requirement from the owner, not a technical one. Trial tier has no such restriction.

## Conventions to keep

- Every DB mutation calls `audit()` — don't skip it, even for "obviously fine" writes
- Every new API route: Zod-validate the body first, verify `initData` second, THEN touch the DB
- Tier caps live in ONE place: `TIER_LIMITS` in `config.ts`. Never hardcode a position cap or buy size elsewhere.
- License tokens are never logged in full (only truncated in Telegram messages) — they're bearer credentials
- No new npm dependencies without checking if Node's stdlib already covers it (see: we didn't need `@noble/ed25519`, native `crypto` was enough)

## Related documents (not in this repo — ask Bogdan or check project knowledge)

- `ARIA_SNIPER_TG_TECHNICAL_SPEC.md` — full system architecture, pricing, roadmap, legal checklist
- `ARIA_SNIPER_VISUAL_SPEC.md` — exact design system (colors, type, component grammar) for any frontend work
- `THREE_SOWS_MASTER.md` — the sniper engine's own honest performance documentation; sales copy must never contradict it

## $RYPTO$ community redirect

`RYPTO_CHANNEL_URL` env var (optional). When set, right after a license is
issued (trial signup, purchase, or renewal) the customer gets DM'd their
license first, then a separate follow-up message with a "JOIN $RYPTO$"
button linking to that URL. See `notifyCustomerLicenseIssued()` in `bot.ts`.

Deliberately NOT fired on Mini App open or before the user has gotten
something real — an unearned redirect prompt reads as spam and Telegram
can flag bots that DM aggressively. If a different trigger point is wanted
(e.g. immediately on `/start`), that's a one-line change in `bot.ts`'s
`/start` handler, but weigh it against that risk first.

## GitHub

Remote: `https://github.com/AIWMCX/aria-telegram-BOT-APP` (was empty at
first push). Repo lives under the AIWMCX org — cross-check this against the
entity separation requirement in the technical spec (`$rypto$-Telegram`
revenue is supposed to stay isolated from AIWMC). Worth a deliberate
decision, not a default: confirm whether the org that hosts the code needs
to match the org that holds the money before this goes further.

## Railway

A Railway MCP connector is available — lets Claude create projects, deploy,
and read logs directly instead of walking through the dashboard manually.
