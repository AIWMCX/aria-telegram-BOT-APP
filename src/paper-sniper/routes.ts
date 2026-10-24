import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { writeKillFlag, writeResumeFlag } from "./control.js";
import { readSniperSnapshot, type SniperSnapshot } from "./data.js";

/**
 * /api/paper-sniper/* - the founder-panel API for the paper sniper (PR E).
 * Same gate pattern as /api/founder-review: strict zod body first, then the
 * Telegram initData HMAC (injected `authenticate`), then the allow-list,
 * then a rate limit. Disabled => 404 for everyone. PAPER ONLY: the only
 * writes are the engine's KILL / RESUME flag files.
 *
 *   POST /status   -> { ok, enabled, available }       (panel reveal check)
 *   POST /summary  -> { ok, snapshot }                  (read-only)
 *   POST /kill     -> { ok } ; body may add { flatten: boolean }
 *   POST /resume   -> { ok }
 */
export interface PaperSniperRouteDeps {
  enabled: boolean;
  allowedTelegramIds: ReadonlySet<string>;
  authenticate: (initData: string) => { user: { id: number }; auth_date: number } | null;
  /** Runtime dir of the user's hosted tenant, derived from a validated clientId (or undefined: no tenant yet). */
  resolveRuntimeDir: (telegramUserId: number) => Promise<string | undefined>;
  now?: () => number;
  readSnapshot?: (runtimeDir: string) => SniperSnapshot;
  /** Reads per minute per user (default 30). */
  readsPerMinute?: number;
  /** Kill/resume per minute per user (default 10). */
  writesPerMinute?: number;
}

const BigSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function paperSniperRoutes(deps: PaperSniperRouteDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const windows = new Map<string, { start: number; n: number }>();
  const Auth = z.object({ initData: z.string().min(10).max(8192) }).strict();
  const Kill = Auth.extend({ flatten: z.boolean().optional() }).strict();

  const limited = (bucket: string, max: number): boolean => {
    const t = now();
    const w = windows.get(bucket);
    if (!w || t - w.start >= 60_000) { windows.set(bucket, { start: t, n: 1 }); return false; }
    return ++w.n > max;
  };

  app.use("*", bodyLimit({ maxSize: 12_000, onError: (c) => c.json({ error: "Request too large" }, 413) }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!deps.enabled || deps.allowedTelegramIds.size === 0) return c.json({ error: "Paper sniper disabled" }, 404);
    await next();
  });

  for (const action of ["status", "summary", "kill", "resume"] as const) {
    app.post("/" + action, async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
      const schema = action === "kill" ? Kill : Auth;
      const parsed = schema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid fields" }, 400);
      const auth = deps.authenticate(parsed.data.initData);
      const t = now();
      if (!auth || !Number.isSafeInteger(auth.user.id) || !deps.allowedTelegramIds.has(String(auth.user.id)) ||
        !Number.isSafeInteger(auth.auth_date) || auth.auth_date > t / 1000 + 30 || t / 1000 - auth.auth_date > 3600) {
        return c.json({ error: "Open a fresh Telegram session as an allowed user" }, 403);
      }
      const uid = auth.user.id;
      const isWrite = action === "kill" || action === "resume";
      if (limited(`${isWrite ? "w" : "r"}:${uid}`, isWrite ? (deps.writesPerMinute ?? 10) : (deps.readsPerMinute ?? 30))) {
        return c.json({ error: "Wait a minute before retrying" }, 429);
      }
      let runtimeDir: string | undefined;
      try { runtimeDir = await deps.resolveRuntimeDir(uid); } catch { return c.json({ error: "Tenant lookup unavailable" }, 503); }
      if (action === "status") return c.json({ ok: true, enabled: true, available: runtimeDir !== undefined });
      if (!runtimeDir) {
        if (isWrite) return c.json({ error: "No hosted PAPER engine for this account yet. Use /paper_start first." }, 409);
        return c.json({ ok: true, snapshot: null, note: "No hosted PAPER engine for this account yet. Use /paper_start first." });
      }
      try {
        if (action === "summary") {
          const snap = (deps.readSnapshot ?? ((d: string) => readSniperSnapshot(d, { now: t })))(runtimeDir);
          return new Response(BigSafe({ ok: true, snapshot: snap }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (action === "kill") writeKillFlag(runtimeDir, (parsed.data as z.infer<typeof Kill>).flatten === true);
        else writeResumeFlag(runtimeDir);
        return c.json({ ok: true, action });
      } catch {
        return c.json({ error: isWrite ? "Could not write the flag file" : "Could not read sniper data" }, 500);
      }
    });
  }
  return app;
}
