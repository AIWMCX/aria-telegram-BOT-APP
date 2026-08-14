# ARIA Terminal Backend

Trial signup, licensing, and Stripe payments for the ARIA Sniper Telegram app.

**New here?** Read [`CLAUDE.md`](./CLAUDE.md) first — it has the full architecture,
what's done, what's not, and the exact deploy steps. This README is the short version.

## Quick start

```bash
npm install
npm run keygen              # generates your license signing keypair — copy the output
cp .env.example .env        # paste the keygen output + fill in the rest
npm run typecheck           # should be zero errors
npm run dev                 # starts on :8080
```

Telegram Mini Apps require HTTPS. For local testing:
```bash
npx ngrok http 8080
# copy the https://...ngrok.io URL into .env as PUBLIC_URL
```

## Deploy to Railway

```bash
git add -A && git commit -m "deploy"
gh repo create aria-terminal --private --source=. --push
# then in Railway: New Project → Deploy from GitHub → select the repo
```

Then in Railway dashboard:
1. **Settings → Volumes** — mount `/data` (SQLite persistence)
2. **Variables** — paste everything from your `.env`
3. **Settings → Networking** — Generate Domain → paste into `PUBLIC_URL` var
4. Check `https://your-domain/healthz` returns `{"ok":true}`

Full details in `CLAUDE.md` → "Deploy checklist."

## What works right now

- Trial signup: form → license issued → emailed → Telegram DM to admin
- Stripe checkout for Standard/Pro (once `STRIPE_*` vars are set)
- License renewal on subscription billing cycle
- `/license`, `/status` bot commands (customer-facing)
- `/stats`, `/revoke` bot commands (admin-only)

## What's not built yet

See `CLAUDE.md` → "What's NOT done" for the full list. Top three: refund
auto-revocation, expiry warning DMs, crypto (SOL/USDC) payment path.

## Opening this in Claude Code

```bash
cd aria-terminal
claude
```

Claude Code will read `CLAUDE.md` automatically on start — that's the
context file, keep it updated as you build.
