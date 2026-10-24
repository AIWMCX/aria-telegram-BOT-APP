import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Private READ-ONLY Solana RPC relay for hosted tenants (PR F1).
 *
 * WHY: tenant engines default to the public mainnet-beta RPC, which 429s the
 * safety gate's calls, so every launch is blocked (fail closed). The founder's
 * paid provider URL (ARIA_STREAM_RPC_HTTP_URL) embeds an API key and must NEVER
 * reach a tenant. This relay lives in the control plane, listens on 127.0.0.1
 * only (never on the public Railway port), and forwards a small allow-list of
 * read-only JSON-RPC methods to the provider with the key attached server-side.
 * A tenant only ever holds `http://127.0.0.1:<port>/rpc/<tenantToken>`.
 *
 * Guarantees (each covered by src/rpc-relay/relay.test.ts):
 *  - method allow-list; sendTransaction / simulateTransaction / requestAirdrop etc. are rejected;
 *  - batches only when EVERY element is allowed (and at most MAX_BATCH elements);
 *  - unknown token => 403; per-tenant + global token buckets => 429;
 *  - request body and upstream response size caps, upstream timeout, no redirects;
 *  - the upstream URL / key is never logged, returned, or stored (responses are scrubbed);
 *  - the HTTP server binds the loopback interface, and the host is a constant, not configurable.
 */

/** Read-only methods only. Deliberately excluded: getLatestBlockhash (not needed), getProgramAccounts (heavy), every write/simulate method. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getTransaction",
  "getSignaturesForAddress",
  "getTokenLargestAccounts",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getBalance",
  "getSlot",
  "getMinimumBalanceForRentExemption",
  "getGenesisHash",
]);

/** The ONLY interface the relay ever listens on. */
export const RELAY_HOST = "127.0.0.1";

export interface RelayLimits {
  /** Sustained requests per second per tenant. */
  tenantRps: number;
  tenantBurst: number;
  /** Sustained requests per second across all tenants (protects the founder's provider plan). */
  globalRps: number;
  globalBurst: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxBatch: number;
  upstreamTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<RelayLimits> = Object.freeze({
  tenantRps: 5,
  tenantBurst: 10,
  globalRps: 25,
  globalBurst: 50,
  maxBodyBytes: 16 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBatch: 10,
  upstreamTimeoutMs: 8000,
});

export type RelayConfig =
  | { enabled: false; reason: string }
  | { enabled: true; port: number; upstreamUrl: string; limits: RelayLimits };

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

function posInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const s = raw?.trim();
  if (!s || !/^\d{1,9}$/.test(s)) return dflt;
  const n = Number(s);
  return n >= min && n <= max ? n : dflt;
}

/** Fail closed: anything missing/malformed => disabled with a reason that never echoes a value. */
export function parseRelayConfig(env: NodeJS.ProcessEnv, publicPort: number): RelayConfig {
  const raw = env.RPC_RELAY_ENABLED?.trim().toLowerCase();
  if (!raw) return { enabled: false, reason: "RPC_RELAY_ENABLED is not set" };
  if (raw === "false" || raw === "0") return { enabled: false, reason: "RPC_RELAY_ENABLED is not true" };
  if (raw !== "true" && raw !== "1") return { enabled: false, reason: "RPC_RELAY_ENABLED must be true/1/false/0" };
  const up = env.ARIA_STREAM_RPC_HTTP_URL;
  if (blank(up)) return { enabled: false, reason: "ARIA_STREAM_RPC_HTTP_URL is not set" };
  let u: URL;
  try { u = new URL(up!.trim()); } catch { return { enabled: false, reason: "ARIA_STREAM_RPC_HTTP_URL is not a valid URL" }; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return { enabled: false, reason: "ARIA_STREAM_RPC_HTTP_URL must be an https:// URL" };
  }
  const port = posInt(env.RPC_RELAY_PORT, 8899, 1024, 65535);
  if (port === publicPort) return { enabled: false, reason: "RPC_RELAY_PORT must differ from the public PORT" };
  const l = DEFAULT_LIMITS;
  const limits: RelayLimits = {
    tenantRps: posInt(env.RPC_RELAY_TENANT_RPS, l.tenantRps, 1, 1000),
    tenantBurst: posInt(env.RPC_RELAY_TENANT_BURST, l.tenantBurst, 1, 1000),
    globalRps: posInt(env.RPC_RELAY_GLOBAL_RPS, l.globalRps, 1, 10000),
    globalBurst: posInt(env.RPC_RELAY_GLOBAL_BURST, l.globalBurst, 1, 10000),
    maxBodyBytes: posInt(env.RPC_RELAY_MAX_BODY_BYTES, l.maxBodyBytes, 256, 1024 * 1024),
    maxResponseBytes: posInt(env.RPC_RELAY_MAX_RESPONSE_BYTES, l.maxResponseBytes, 1024, 32 * 1024 * 1024),
    maxBatch: posInt(env.RPC_RELAY_MAX_BATCH, l.maxBatch, 1, 100),
    upstreamTimeoutMs: posInt(env.RPC_RELAY_UPSTREAM_TIMEOUT_MS, l.upstreamTimeoutMs, 500, 60000),
  };
  return { enabled: true, port, upstreamUrl: up!.trim(), limits };
}

/** Classic token bucket; `now` is injectable so tests need no sleeping. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly ratePerSec: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  private refill(now: number): void {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.ratePerSec);
  }
  canTake(cost: number, now: number): boolean {
    this.refill(now);
    return this.tokens >= cost;
  }
  take(cost: number): void { this.tokens -= cost; }
  /** Seconds until `cost` tokens are available (>= 1). */
  retryAfterSec(cost: number): number {
    return Math.max(1, Math.ceil(Math.max(0, cost - this.tokens) / this.ratePerSec));
  }
}

export interface RelayCounts { requests: number; rejectedMethod: number; rateLimited: number; upstreamErrors: number }

const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

export function newTenantToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Strings from the upstream URL that must never leave this process (whole URL, query values, long path segments, userinfo). */
export function upstreamSecrets(upstreamUrl: string): string[] {
  const out = new Set<string>([upstreamUrl]);
  try {
    const u = new URL(upstreamUrl);
    for (const [, v] of u.searchParams) if (v.length >= 6) out.add(v);
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) out.add(seg);
    if (u.password.length >= 4) out.add(u.password);
    if (u.username.length >= 6) out.add(u.username);
    if (u.search.length > 1) out.add(u.search);
  } catch { /* validated at parse time */ }
  return [...out].sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
}

type Json = Record<string, unknown>;
const rpcError = (id: unknown, code: number, message: string): Json => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export interface RelayResult { status: number; body: unknown; headers?: Record<string, string> }

export interface RpcRelayOptions {
  upstreamUrl: string;
  limits?: Partial<RelayLimits>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class RpcRelay {
  readonly limits: RelayLimits;
  private readonly upstreamUrl: string;
  private readonly secrets: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** sha256(token) -> clientId. Hashing means a lookup never compares the raw token. */
  private readonly tokens = new Map<string, string>();
  private readonly tenantBuckets = new Map<string, TokenBucket>();
  private readonly globalBucket: TokenBucket;
  private server?: Server;
  private readonly c: RelayCounts = { requests: 0, rejectedMethod: 0, rateLimited: 0, upstreamErrors: 0 };

  constructor(o: RpcRelayOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
    this.upstreamUrl = o.upstreamUrl;
    this.secrets = upstreamSecrets(o.upstreamUrl);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.globalBucket = new TokenBucket(this.limits.globalRps, this.limits.globalBurst, this.now());
  }

  /** Makes `token` valid for `clientId`. Idempotent. */
  registerToken(clientId: string, token: string): void {
    this.tokens.set(hashToken(token), clientId);
  }
  tenantCount(): number { return new Set(this.tokens.values()).size; }
  counts(): RelayCounts { return { ...this.c }; }

  /** Core request handler, independent of HTTP: easy to test and to reason about. */
  async handle(req: { method: string; url: string; body?: string; bodyTooLarge?: boolean }): Promise<RelayResult> {
    this.c.requests++;
    const m = /^\/rpc\/([A-Za-z0-9_-]{16,128})\/?$/.exec((req.url ?? "").split("?")[0] ?? "");
    if (!m) return { status: 404, body: { error: "not found" } };
    const clientId = this.tokens.get(hashToken(m[1]!));
    if (clientId === undefined) return { status: 403, body: { error: "forbidden" } };
    if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" }, headers: { Allow: "POST" } };
    if (req.bodyTooLarge) return { status: 413, body: rpcError(null, -32600, "request too large") };

    let parsed: unknown;
    try { parsed = JSON.parse(req.body ?? ""); } catch { return { status: 400, body: rpcError(null, -32700, "parse error") }; }

    const isBatch = Array.isArray(parsed);
    const items: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
    if (items.length === 0 || items.length > this.limits.maxBatch) {
      return { status: 400, body: rpcError(null, -32600, items.length === 0 ? "invalid request" : "batch too large") };
    }
    for (const it of items) {
      if (typeof it !== "object" || it === null || Array.isArray(it)) return { status: 400, body: rpcError(null, -32600, "invalid request") };
      const o = it as Json;
      if (typeof o.method !== "string" || (o.params !== undefined && !Array.isArray(o.params))) {
        return { status: 400, body: rpcError(o.id, -32600, "invalid request") };
      }
      if (!ALLOWED_METHODS.has(o.method)) {
        this.c.rejectedMethod++;
        // Whole batch is refused when any element is not allowed.
        return { status: 200, body: rpcError(isBatch ? null : o.id, -32601, "method not allowed by the read-only relay") };
      }
    }

    // Rate limit (per element cost). Check both buckets before consuming either.
    const cost = items.length;
    const t = this.now();
    let tb = this.tenantBuckets.get(clientId);
    if (!tb) { tb = new TokenBucket(this.limits.tenantRps, this.limits.tenantBurst, t); this.tenantBuckets.set(clientId, tb); }
    const tenantOk = tb.canTake(cost, t);
    const globalOk = this.globalBucket.canTake(cost, t);
    if (!tenantOk || !globalOk) {
      this.c.rateLimited++;
      const wait = Math.max(!tenantOk ? tb.retryAfterSec(cost) : 1, !globalOk ? this.globalBucket.retryAfterSec(cost) : 1);
      return { status: 429, body: rpcError(null, -32005, "rate limited"), headers: { "Retry-After": String(wait) } };
    }
    tb.take(cost);
    this.globalBucket.take(cost);

    return this.forward(req.body!);
  }

  private async forward(body: string): Promise<RelayResult> {
    const fail = (status: number, msg: string): RelayResult => {
      this.c.upstreamErrors++;
      return { status, body: rpcError(null, -32603, msg) };
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.limits.upstreamTimeoutMs),
      });
    } catch {
      // Error text can embed the URL: never forward or log it.
      return fail(502, "upstream unavailable");
    }
    let text: string;
    try {
      text = await readCapped(res, this.limits.maxResponseBytes);
    } catch (e) {
      return fail(502, (e as Error).message === "too_large" ? "upstream response too large" : "upstream unavailable");
    }
    if (res.status === 429) {
      this.c.upstreamErrors++;
      return { status: 429, body: rpcError(null, -32005, "upstream rate limited"), headers: { "Retry-After": "1" } };
    }
    if (res.status < 200 || res.status >= 300) return fail(502, "upstream error");
    const clean = scrub(text, this.secrets);
    let json: unknown;
    try { json = JSON.parse(clean); } catch { return fail(502, "upstream returned non-JSON"); }
    return { status: 200, body: json };
  }

  /** Starts the loopback HTTP server. Resolves with the bound port. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => { void this.onHttp(req, res); });
      srv.requestTimeout = 30_000;
      srv.headersTimeout = 10_000;
      srv.once("error", reject);
      srv.listen(port, RELAY_HOST, () => {
        srv.removeListener("error", reject);
        this.server = srv;
        resolve((srv.address() as AddressInfo).port);
      });
    });
  }

  boundAddress(): AddressInfo | undefined {
    const a = this.server?.address();
    return a && typeof a === "object" ? a : undefined;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = undefined;
    });
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (r: RelayResult) => {
      const payload = JSON.stringify(r.body);
      res.writeHead(r.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", ...(r.headers ?? {}) });
      res.end(payload);
    };
    try {
      const declared = Number(req.headers["content-length"] ?? 0);
      let tooLarge = Number.isFinite(declared) && declared > this.limits.maxBodyBytes;
      let body = "";
      if (!tooLarge) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > this.limits.maxBodyBytes) { tooLarge = true; break; }
          chunks.push(chunk as Buffer);
        }
        body = Buffer.concat(chunks).toString("utf8");
      }
      const out = await this.handle({ method: req.method ?? "", url: req.url ?? "", body, bodyTooLarge: tooLarge });
      send(out);
      if (tooLarge) req.destroy();
    } catch {
      try { send({ status: 500, body: rpcError(null, -32603, "internal error") }); } catch { /* socket gone */ }
    }
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > cap) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new Error("too_large"); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error("too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
