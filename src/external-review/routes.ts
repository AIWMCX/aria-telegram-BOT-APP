import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Address, Signature, SOL_MINT, jupiterLink, verifySignature } from './verification.js';

type Dependencies = {
  enabled: boolean; founderId: string; rpcUrl?: string;
  authenticate: (initData: string) => { user: { id: number }; auth_date: number } | null;
  verify?: typeof verifySignature;
};
export function externalReviewRoutes(deps: Dependencies) {
  const app = new Hono();
  // One explicitly configured founder, no public RPC proxy and no unbounded map.
  let windowStart = 0, requests = 0, busy = false;
  const Auth = z.object({ initData: z.string().min(10).max(8192) }).strict();
  const Mint = Address.refine(v => v !== SOL_MINT, 'Choose a non-SOL mint');
  const Handoff = Auth.extend({ mint: Mint, side: z.enum(['buy', 'sell']) });
  const Verify = Auth.extend({ wallet: Address, mint: Mint, signature: Signature });
  app.use('*', bodyLimit({ maxSize: 12_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.enabled || !/^[1-9]\d*$/.test(deps.founderId)) return c.json({ error: 'Founder review disabled' }, 404);
    await next();
  });
  for (const action of ['status', 'handoff', 'verify'] as const) {
    app.post('/' + action, async c => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
      const parsed = (action === 'status' ? Auth : action === 'handoff' ? Handoff : Verify).safeParse(body);
      if (!parsed.success) return c.json({ error: 'Invalid fields; only public addresses and transaction signatures are accepted' }, 400);
      const auth = deps.authenticate(parsed.data.initData);
      const now = Date.now();
      if (!auth || !Number.isSafeInteger(auth.user.id) || String(auth.user.id) !== deps.founderId ||
        !Number.isSafeInteger(auth.auth_date) || auth.auth_date > now / 1000 + 30 || now / 1000 - auth.auth_date > 3600)
        return c.json({ error: 'Open a fresh founder Telegram session' }, 403);
      if (action === 'status') return c.json({ ok: true, verifierConfigured: Boolean(deps.rpcUrl), execution: 'external_wallet_only' });
      if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
      if (++requests > 10) return c.json({ error: 'Wait a minute before retrying' }, 429);
      if (action === 'handoff') {
        const input = Handoff.parse(body);
        return c.json({ ok: true, url: jupiterLink(input.mint, input.side), amountPrefilled: false, note: 'Review token, amount, fees and slippage in Jupiter. ARIA does not enforce external trade limits.' });
      }
      if (!deps.rpcUrl) return c.json({ error: 'Mainnet verification RPC not configured' }, 503);
      if (busy) return c.json({ error: 'Verification in progress; retry shortly' }, 429);
      busy = true;
      try {
        const input = Verify.parse(body);
        const observation = await (deps.verify ?? verifySignature)(deps.rpcUrl, input.signature, input.wallet, input.mint);
        return c.json({ ok: true, observation });
      } catch {
        // Never echo provider URLs, authentication data, or raw RPC errors.
        return c.json({ error: 'Unable to verify. Check the signature, wallet and mint; unsupported or incomplete transactions remain unverified.' }, 422);
      } finally { busy = false; }
    });
  }
  return app;
}
