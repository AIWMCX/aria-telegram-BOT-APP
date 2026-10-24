import http from "node:http";
import os from "node:os";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { ALLOWED_METHODS, checkParams, DEFAULT_LIMITS, hasDuplicateKeys, parseRelayConfig, RpcRelay, TokenBucket, RELAY_HOST, scrub, upstreamSecrets } from "./relay.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

const KEY = "FAKEHELIUSKEY-9f3a71c2d8";
const TOKEN_A = "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// ── fake upstream provider (real loopback HTTP server so the whole path is exercised) ──
const upstreamHits: { url: string; body: string }[] = [];
let upstreamMode: "ok" | "echo-key" | "500" | "429" | "big" | "slow" | "nonjson" | "big-chunked" = "ok";
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits.push({ url: req.url ?? "", body });
    if (upstreamMode === "500") { res.writeHead(500); res.end(`boom http://127.0.0.1/?api-key=${KEY}`); return; }
    if (upstreamMode === "429") { res.writeHead(429, { "retry-after": "2" }); res.end("slow down"); return; }
    if (upstreamMode === "big") { res.writeHead(200); res.end("x".repeat(5000)); return; }
    if (upstreamMode === "big-chunked") { res.writeHead(200, { "transfer-encoding": "chunked" }); res.write("{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"" + "x".repeat(600)); res.end("y".repeat(600) + "\"}"); return; }
    if (upstreamMode === "slow") { setTimeout(() => { try { res.writeHead(200); res.end("{}"); } catch { /* closed */ } }, 1500); return; }
    if (upstreamMode === "nonjson") { res.writeHead(200); res.end("<html>nope</html>"); return; }
    let id: unknown = 1;
    let out: unknown;
    try {
      const p = JSON.parse(body);
      out = Array.isArray(p) ? p.map((x: any) => ({ jsonrpc: "2.0", id: x.id, result: 1 })) : { jsonrpc: "2.0", id: p.id, result: upstreamMode === "echo-key" ? { echoedUrl: `http://127.0.0.1:1/?api-key=${KEY}`, k: KEY } : "ok" };
    } catch { out = { jsonrpc: "2.0", id, result: null }; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upPort = (upstream.address() as AddressInfo).port;
const UPSTREAM_URL = `http://127.0.0.1:${upPort}/v1/${KEY}?api-key=${KEY}`;

let clock = 1_000_000;
const relay = new RpcRelay({ upstreamUrl: UPSTREAM_URL, now: () => clock, limits: { tenantRps: 5, tenantBurst: 10, globalRps: 100, globalBurst: 100, maxBodyBytes: 2048, maxResponseBytes: 1000, maxBatch: 3, upstreamTimeoutMs: 500 } });
relay.registerToken("client-a", TOKEN_A);
relay.registerToken("client-b", TOKEN_B);
const port = await relay.listen(0);
const everything: string[] = []; // every byte a tenant ever saw

async function post(token: string, body: unknown, opts: { method?: string; raw?: string; path?: string } = {}) {
  const r = await fetch(`http://${RELAY_HOST}:${port}${opts.path ?? `/rpc/${token}`}`, {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: (opts.method ?? "POST") === "GET" ? undefined : opts.raw ?? JSON.stringify(body),
  });
  const text = await r.text();
  everything.push(`${r.status} ${[...r.headers].join(",")} ${text}`);
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, headers: r.headers };
}
const call = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 7, method, params });
const refill = () => { clock += 60_000; };

// ── 1. method allow-list ─────────────────────────────────────────────
for (const m of ALLOWED_METHODS) {
  refill();
  const hitsBefore = upstreamHits.length;
  const okParams: Record<string, unknown[]> = { getMultipleAccounts: [["k"]], getTokenAccountsByOwner: ["o", { mint: "m" }] };
  const r = await post(TOKEN_A, call(m, okParams[m] ?? []));
  if (!(r.status === 200 && r.json?.result === "ok" && upstreamHits.length === hitsBefore + 1)) check(`allowed method ${m} is forwarded`, false);
}
check("every allow-listed method forwards and returns the upstream result", true);
check("allow-list contains exactly the 11 read-only methods requested", ALLOWED_METHODS.size === 11 && !ALLOWED_METHODS.has("getLatestBlockhash") && !ALLOWED_METHODS.has("getProgramAccounts"));
for (const m of ["sendTransaction", "simulateTransaction", "requestAirdrop", "getProgramAccounts", "getLatestBlockhash", "sendRawTransaction", "isBlockhashValid", "__proto__"]) {
  refill();
  const before = upstreamHits.length;
  const r = await post(TOKEN_A, call(m));
  check(`${m} is rejected with a JSON-RPC error and never reaches the upstream`, r.json?.error?.code === -32601 && r.json?.id === 7 && upstreamHits.length === before);
}
check("rejectedMethod counter counts rejections", relay.counts().rejectedMethod === 8);
refill();
check("non-array params -> 400 invalid request", (await post(TOKEN_A, { jsonrpc: "2.0", id: 1, method: "getSlot", params: "x" })).status === 400);
check("malformed JSON -> 400 parse error", (await post(TOKEN_A, undefined, { raw: "{nope" })).json?.error?.code === -32700);

// ── 2. batch handling ────────────────────────────────────────────────
refill();
let before = upstreamHits.length;
let r = await post(TOKEN_A, [call("getSlot"), call("getBalance", ["x"])]);
check("all-allowed batch is forwarded as one upstream call and returns an array", r.status === 200 && Array.isArray(r.json) && r.json.length === 2 && upstreamHits.length === before + 1);
before = upstreamHits.length;
r = await post(TOKEN_A, [call("getSlot"), call("sendTransaction"), call("getBalance")]);
check("batch with ONE disallowed element is rejected whole, nothing reaches the upstream", r.json?.error?.code === -32601 && upstreamHits.length === before);
check("empty batch is rejected", (await post(TOKEN_A, [])).status === 400);
check("batch above maxBatch is rejected", (await post(TOKEN_A, [call("getSlot"), call("getSlot"), call("getSlot"), call("getSlot")])).status === 400);
check("batch containing a non-object is rejected", (await post(TOKEN_A, [call("getSlot"), 5])).status === 400);

// ── 3. per-tenant auth ───────────────────────────────────────────────
before = upstreamHits.length;
r = await post("unknownTokenUnknownTokenUnknownToken1", call("getSlot"));
check("unknown token -> 403 and nothing forwarded", r.status === 403 && upstreamHits.length === before);
check("path without token -> 404", (await post("", call("getSlot"), { path: "/rpc/" })).status === 404);
check("other paths -> 404", (await post("", call("getSlot"), { path: "/" })).status === 404);
check("known token but GET -> 405", (await post(TOKEN_A, undefined, { method: "GET" })).status === 405);
check("token prefix is not accepted", (await post(TOKEN_A.slice(0, 30), call("getSlot"))).status === 403);

// ── 4. rate limits ───────────────────────────────────────────────────
refill();
let statuses: number[] = [];
for (let i = 0; i < 12; i++) statuses.push((await post(TOKEN_A, call("getSlot"))).status);
check("per-tenant burst of 10 passes then HTTP 429", statuses.slice(0, 10).every((s) => s === 200) && statuses[10] === 429 && statuses[11] === 429);
const limited = await post(TOKEN_A, call("getSlot"));
check("429 carries Retry-After and a JSON-RPC error", limited.status === 429 && Number(limited.headers.get("retry-after")) >= 1 && limited.json?.error?.code === -32005);
check("another tenant is unaffected by tenant A's limit", (await post(TOKEN_B, call("getSlot"))).status === 200);
clock += 1000; // 5 rps -> 5 tokens
statuses = [];
for (let i = 0; i < 6; i++) statuses.push((await post(TOKEN_A, call("getSlot"))).status);
check("bucket refills at the configured rate (5/s)", statuses.slice(0, 5).every((s) => s === 200) && statuses[5] === 429);
check("rateLimited counter counts 429s", relay.counts().rateLimited >= 4);
refill();
before = upstreamHits.length;
r = await post(TOKEN_B, [call("getSlot"), call("getSlot"), call("getSlot")]);
check("a batch costs one token per element", r.status === 200 && (await (async () => { refill(); let n = 0; for (let i = 0; i < 12; i++) if ((await post(TOKEN_B, call("getSlot"))).status === 200) n++; return n; })()) === 10);

// global cap: separate relay with a tiny global bucket
{
  let c2 = 5_000_000;
  const g = new RpcRelay({ upstreamUrl: UPSTREAM_URL, now: () => c2, limits: { tenantRps: 100, tenantBurst: 100, globalRps: 1, globalBurst: 3, maxBatch: 1 } });
  g.registerToken("a", TOKEN_A); g.registerToken("b", TOKEN_B);
  const s: number[] = [];
  for (const t of [TOKEN_A, TOKEN_B, TOKEN_A, TOKEN_B]) s.push((await g.handle({ method: "POST", url: `/rpc/${t}`, body: JSON.stringify(call("getSlot")) })).status);
  check("global cap applies across tenants (3 pass, 4th -> 429 even though each tenant is under its own limit)", s[0] === 200 && s[1] === 200 && s[2] === 200 && s[3] === 429);
}

// ── 5. size caps / timeouts ──────────────────────────────────────────
refill();
r = await post(TOKEN_A, undefined, { raw: JSON.stringify({ ...call("getSlot"), pad: "x".repeat(5000) }) });
check("oversized request body -> 413", r.status === 413);
{
  refill();
  const chunked = await new Promise<number>((resolve) => {
    const rq = http.request({ host: RELAY_HOST, port, path: `/rpc/${TOKEN_A}`, method: "POST", headers: { "transfer-encoding": "chunked", "content-type": "application/json" } }, (rs) => { rs.resume(); resolve(rs.statusCode ?? 0); });
    rq.on("error", () => resolve(-1));
    rq.write("[" + "0,".repeat(1500)); rq.write("0".repeat(1500) + "]"); rq.end();
  });
  check("oversized CHUNKED request body (no content-length) -> 413", chunked === 413);
}
upstreamMode = "big"; refill();
r = await post(TOKEN_A, call("getSlot"));
check("oversized upstream response -> 502 (capped, not forwarded)", r.status === 502 && !JSON.stringify(r.json).includes("xxxx"));
upstreamMode = "big-chunked"; refill();
r = await post(TOKEN_A, call("getSlot"));
check("oversized CHUNKED upstream response (no content-length) is cut off at the cap -> 502", r.status === 502 && !JSON.stringify(r.json).includes("yyyy"));
upstreamMode = "slow"; refill();
const t0 = Date.now();
r = await post(TOKEN_A, call("getSlot"));
check("slow upstream -> 502 within the timeout", r.status === 502 && Date.now() - t0 < 1400);
upstreamMode = "500"; refill();
r = await post(TOKEN_A, call("getSlot"));
check("upstream 500 -> 502 generic error, upstream body not forwarded", r.status === 502 && !JSON.stringify(r.json).includes("boom"));
upstreamMode = "429"; refill();
r = await post(TOKEN_A, call("getSlot"));
check("upstream 429 -> 429 to the tenant (engine fails closed)", r.status === 429);
upstreamMode = "nonjson"; refill();
check("upstream non-JSON -> 502", (await post(TOKEN_A, call("getSlot"))).status === 502);
check("upstreamErrors counter counts these", relay.counts().upstreamErrors >= 5);

// ── 6. the key never leaks ───────────────────────────────────────────
upstreamMode = "echo-key"; refill();
r = await post(TOKEN_A, call("getSlot"));
check("an upstream response that echoes the key/URL is scrubbed before it reaches the tenant", r.status === 200 && !JSON.stringify(r.json).includes(KEY) && JSON.stringify(r.json).includes("[REDACTED]"));
{
  const failing = new RpcRelay({ upstreamUrl: UPSTREAM_URL, fetchImpl: (async () => { throw new Error(`fetch failed for ${UPSTREAM_URL}`); }) as any });
  failing.registerToken("a", TOKEN_A);
  const out = await failing.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  check("a fetch error (whose message embeds the URL) is replaced by a generic error", out.status === 502 && !JSON.stringify(out).includes(KEY));
}
check("upstream received the tenant JSON-RPC body unchanged and the key was attached server-side", upstreamHits.some((h) => h.url.includes(KEY) && JSON.parse(h.body).method === "getSlot"));
upstreamMode = "ok";
const secrets = upstreamSecrets(UPSTREAM_URL);
check("scrub removes every secret form (full URL, query value, path segment)", !scrub(`a ${UPSTREAM_URL} b ${KEY}`, secrets).includes(KEY));
const everythingText = everything.join("\n") + JSON.stringify(relay.counts());
check("grep of EVERY byte returned to tenants for the fake key: none", !everythingText.includes(KEY) && !everythingText.includes(String(upPort)));
check("tenant tokens are not in any response body", !everythingText.includes(TOKEN_B));

// ── 6b. review follow-ups ────────────────────────────────────────────
// (1) duplicate-key method smuggling + forwarding a REBUILT body, never the raw text
upstreamMode = "ok"; refill();
before = upstreamHits.length;
r = await post(TOKEN_A, undefined, { raw: '{"jsonrpc":"2.0","id":1,"method":"sendTransaction","method":"getSlot","params":[]}' });
check("duplicate-key body (method twice) is rejected with 400 and never reaches the upstream", r.status === 400 && upstreamHits.length === before);
r = await post(TOKEN_A, undefined, { raw: '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"a":1,"a":2}]}' });
check("a duplicate key nested inside params is rejected too", r.status === 400 && upstreamHits.length === before);
r = await post(TOKEN_A, undefined, { raw: '[{"jsonrpc":"2.0","id":1,"method":"getSlot"},{"id":2,"id":3,"method":"getSlot"}]' });
check("a duplicate key inside one batch element rejects the whole batch", r.status === 400 && upstreamHits.length === before);
check("hasDuplicateKeys has no false positives (same key in different objects, key text inside strings, escaped quotes)",
  !hasDuplicateKeys('{"a":1,"b":{"a":2},"c":[{"a":1},{"a":2}],"d":"\\"a\\":1,\\"a\\":2"}') && hasDuplicateKeys('{"a":{"x":1},"a":2}') && hasDuplicateKeys('{"k\\u0061":1,"ka":2}'));
refill();
r = await post(TOKEN_A, undefined, { raw: '{"method":"getSlot","params":[],"id":"x","evil":{"method":"sendTransaction"},"jsonrpc":"1.0"}' });
const fwd = JSON.parse(upstreamHits[upstreamHits.length - 1]!.body);
check("upstream receives ONLY the rebuilt {jsonrpc,id,method,params}: extra fields dropped, jsonrpc forced to 2.0",
  r.status === 200 && JSON.stringify(fwd) === JSON.stringify({ jsonrpc: "2.0", id: "x", method: "getSlot", params: [] }));
refill();
await post(TOKEN_A, [{ ...call("getSlot"), extra: 1 }, { method: "getBalance", params: ["a"], id: 9 }]);
check("a batch is forwarded as an array of rebuilt items", JSON.stringify(JSON.parse(upstreamHits[upstreamHits.length - 1]!.body)) === JSON.stringify([{ jsonrpc: "2.0", id: 7, method: "getSlot", params: [] }, { jsonrpc: "2.0", id: 9, method: "getBalance", params: ["a"] }]));
refill();
r = await post(TOKEN_A, { jsonrpc: "2.0", id: { x: 1 }, method: "getSlot" });
check("an object id is rejected (400)", r.status === 400);

// (3) upstream 429 circuit breaker
upstreamMode = "429"; refill();
await post(TOKEN_A, call("getSlot"));
const hitsAfter429 = upstreamHits.length;
upstreamMode = "ok";
clock += 500; // still inside the 2 s Retry-After
r = await post(TOKEN_B, call("getSlot"));
check("after an upstream 429 the relay pauses: other tenants get 429 and NOTHING is forwarded during Retry-After", r.status === 429 && Number(r.headers.get("retry-after")) >= 1 && upstreamHits.length === hitsAfter429);
clock += 3000;
r = await post(TOKEN_B, call("getSlot"));
check("forwarding resumes once Retry-After has passed", r.status === 200 && upstreamHits.length === hitsAfter429 + 1);
{
  // no Retry-After header => exponential backoff (1 s, then 2 s)
  let c3 = 9_000_000; let mode429 = true; let hits3 = 0;
  const fetch3 = (async () => { hits3++; return mode429 ? new Response("x", { status: 429 }) : new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200 }); }) as any;
  const g = new RpcRelay({ upstreamUrl: UPSTREAM_URL, now: () => c3, fetchImpl: fetch3, limits: { tenantRps: 100, tenantBurst: 100, globalRps: 100, globalBurst: 100 } });
  g.registerToken("a", TOKEN_A);
  const go = () => g.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  await go(); const h1 = hits3;
  c3 += 500; const mid = await go();
  c3 += 600; await go(); // 2nd upstream 429 => backoff doubles to 2 s
  c3 += 1500; const still = await go();
  check("exponential backoff without Retry-After: 1 s first, then 2 s", mid.status === 429 && hits3 === h1 + 1 && still.status === 429 && hits3 === h1 + 1);
  c3 += 1000; mode429 = false; const back = await go();
  check("...and recovers after the pause", back.status === 200);
}

// (4) parameter caps
refill();
before = upstreamHits.length;
const capCases: Array<[string, unknown, boolean]> = [
  ["getSignaturesForAddress limit 1000 (engine page size)", call("getSignaturesForAddress", ["a", { limit: 1000 }]), true],
  ["getSignaturesForAddress without limit (RPC default 1000)", call("getSignaturesForAddress", ["a"]), true],
  ["getSignaturesForAddress limit 1001", call("getSignaturesForAddress", ["a", { limit: 1001 }]), false],
  ["getSignaturesForAddress limit 0", call("getSignaturesForAddress", ["a", { limit: 0 }]), false],
  ["getSignaturesForAddress limit as string", call("getSignaturesForAddress", ["a", { limit: "5" }]), false],
  ["getMultipleAccounts with 20 keys", call("getMultipleAccounts", [Array(20).fill("k")]), true],
  ["getMultipleAccounts with 21 keys", call("getMultipleAccounts", [Array(21).fill("k")]), false],
  ["getMultipleAccounts with no keys array", call("getMultipleAccounts", ["k"]), false],
  ["getTokenAccountsByOwner with a mint filter", call("getTokenAccountsByOwner", ["o", { mint: "m" }, { encoding: "base64" }]), true],
  ["getTokenAccountsByOwner with a programId filter", call("getTokenAccountsByOwner", ["o", { programId: "p" }]), false],
  ["getTokenAccountsByOwner without a filter", call("getTokenAccountsByOwner", ["o"]), false],
];
for (const [name, body, allowed] of capCases) {
  refill();
  const b = upstreamHits.length;
  const rr = await post(TOKEN_A, body);
  check(`param cap: ${name} -> ${allowed ? "forwarded" : "rejected, not forwarded"}`, allowed ? rr.status === 200 && upstreamHits.length === b + 1 : rr.json?.error?.code === -32602 && upstreamHits.length === b);
}
{
  const lim = { ...DEFAULT_LIMITS, maxSignaturesLimit: 100 };
  check("a lower configured signatures ceiling applies (limit 100 ok, 101 and absent rejected)",
    checkParams("getSignaturesForAddress", ["a", { limit: 100 }], lim) === undefined && checkParams("getSignaturesForAddress", ["a", { limit: 101 }], lim) !== undefined && checkParams("getSignaturesForAddress", ["a"], lim) !== undefined);
}

// (5) token revocation on stop
{
  const rv = new RpcRelay({ upstreamUrl: UPSTREAM_URL });
  rv.registerToken("c1", TOKEN_A);
  const hit = () => rv.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  const ok1 = (await hit()).status;
  rv.unregisterClient("c1");
  check("unregisterClient revokes the tenant's token at once (403), re-registering restores it", ok1 === 200 && (await hit()).status === 403 && (rv.registerToken("c1", TOKEN_A), (await hit()).status === 200));
}

// (6) redirects are never followed
{
  const target = http.createServer((q, s) => { upstreamHits.push({ url: "REDIRECT-TARGET " + q.url, body: "" }); s.writeHead(200); s.end('{"jsonrpc":"2.0","id":1,"result":"followed"}'); });
  await new Promise<void>((r2) => target.listen(0, "127.0.0.1", () => r2()));
  const tport = (target.address() as AddressInfo).port;
  const redir = http.createServer((q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${tport}/stolen` }); s.end(); });
  await new Promise<void>((r2) => redir.listen(0, "127.0.0.1", () => r2()));
  const rr = new RpcRelay({ upstreamUrl: `http://127.0.0.1:${(redir.address() as AddressInfo).port}/?api-key=${KEY}` });
  rr.registerToken("c", TOKEN_A);
  const out = await rr.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  check("an upstream redirect is NOT followed: 502 and the redirect target is never contacted", out.status === 502 && !upstreamHits.some((h) => h.url.startsWith("REDIRECT-TARGET")));
  let seenRedirect = "";
  const spy = new RpcRelay({ upstreamUrl: UPSTREAM_URL, fetchImpl: (async (_u: any, init: any) => { seenRedirect = init.redirect; return new Response("{}", { status: 200 }); }) as any });
  spy.registerToken("c", TOKEN_A);
  await spy.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  check("fetch is always called with redirect:error", seenRedirect === "error");
  await new Promise<void>((r2) => target.close(() => r2()));
  await new Promise<void>((r2) => redir.close(() => r2()));
}

// (2)/(3) config: new defaults and the batch/burst invariant
{
  const d = DEFAULT_LIMITS;
  check("defaults sized for the provider plan: tenant 3 rps / burst 6, global 8 rps / burst 16, 512 KiB response cap", d.tenantRps === 3 && d.tenantBurst === 6 && d.globalRps === 8 && d.globalBurst === 16 && d.maxResponseBytes === 512 * 1024);
  const e = { RPC_RELAY_ENABLED: "true", ARIA_STREAM_RPC_HTTP_URL: "https://mainnet.helius-rpc.com/?api-key=" + KEY } as any;
  const okc = parseRelayConfig(e, 8080);
  check("default maxBatch (5) satisfies maxBatch <= min(tenantBurst, globalBurst)", okc.enabled && okc.limits.maxBatch <= Math.min(okc.limits.tenantBurst, okc.limits.globalBurst));
  const bad = parseRelayConfig({ ...e, RPC_RELAY_MAX_BATCH: "9" }, 8080);
  check("maxBatch above the tenant burst -> config validation error (disabled, reason, no value echoed)", !bad.enabled && /MAX_BATCH/.test(bad.reason) && !bad.reason.includes(KEY));
  check("maxBatch above the global burst -> disabled", !parseRelayConfig({ ...e, RPC_RELAY_TENANT_BURST: "50", RPC_RELAY_GLOBAL_BURST: "4", RPC_RELAY_MAX_BATCH: "5" }, 8080).enabled);
  let threw = false; try { new RpcRelay({ upstreamUrl: UPSTREAM_URL, limits: { tenantBurst: 2, maxBatch: 5 } }); } catch { threw = true; }
  check("the RpcRelay constructor refuses maxBatch > burst too", threw);
}
{
  // the scrub only runs when a fragment is present: a clean response is passed through byte-for-byte
  const clean = '{"jsonrpc":"2.0","id":1,"result":{"v":"[REDACTED] literal in upstream data stays"}}';
  const cr = new RpcRelay({ upstreamUrl: UPSTREAM_URL, fetchImpl: (async () => new Response(clean, { status: 200 })) as any });
  cr.registerToken("c", TOKEN_A);
  const out = await cr.handle({ method: "POST", url: `/rpc/${TOKEN_A}`, body: JSON.stringify(call("getSlot")) });
  check("a response without any secret fragment is returned unchanged", JSON.stringify(out.body) === JSON.stringify(JSON.parse(clean)));
}

// ── 7. loopback-only binding ─────────────────────────────────────────
const addr = relay.boundAddress()!;
check("relay HTTP server is bound to 127.0.0.1 (not 0.0.0.0 / ::)", addr.address === "127.0.0.1" && RELAY_HOST === "127.0.0.1");
const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
if (external) {
  const refused = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: external.address, port: addr.port });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
  check(`connecting via the machine's non-loopback address (${external.family}) is refused`, refused);
} else check("(no non-loopback interface on this machine; address check above is the proof)", true);

// ── 8. config parsing ────────────────────────────────────────────────
const H = "https://mainnet.helius-rpc.com/?api-key=" + KEY;
const dis = (e: Record<string, string>) => parseRelayConfig(e as any, 8080);
check("unset -> disabled", dis({ ARIA_STREAM_RPC_HTTP_URL: H }).enabled === false);
check("RPC_RELAY_ENABLED=false -> disabled", dis({ RPC_RELAY_ENABLED: "false", ARIA_STREAM_RPC_HTTP_URL: H }).enabled === false);
check("enabled but no upstream URL -> disabled", dis({ RPC_RELAY_ENABLED: "true" }).enabled === false);
check("enabled with plain http non-loopback upstream -> disabled", dis({ RPC_RELAY_ENABLED: "true", ARIA_STREAM_RPC_HTTP_URL: "http://evil.example/?k=1" }).enabled === false);
check("RPC_RELAY_PORT equal to the public PORT -> disabled", dis({ RPC_RELAY_ENABLED: "true", ARIA_STREAM_RPC_HTTP_URL: H, RPC_RELAY_PORT: "8080" }).enabled === false);
const ok = dis({ RPC_RELAY_ENABLED: "true", ARIA_STREAM_RPC_HTTP_URL: H });
check("enabled + https upstream -> enabled on default port 8899 with 3 rps / burst 6", ok.enabled && ok.port === 8899 && ok.limits.tenantRps === 3 && ok.limits.tenantBurst === 6);
const custom = dis({ RPC_RELAY_ENABLED: "1", ARIA_STREAM_RPC_HTTP_URL: H, RPC_RELAY_PORT: "9100", RPC_RELAY_TENANT_RPS: "2", RPC_RELAY_GLOBAL_RPS: "7" });
check("limits and port are configurable; malformed values fall back to defaults", custom.enabled && custom.port === 9100 && custom.limits.tenantRps === 2 && custom.limits.globalRps === 7 && dis({ RPC_RELAY_ENABLED: "1", ARIA_STREAM_RPC_HTTP_URL: H, RPC_RELAY_TENANT_RPS: "abc" }).enabled);
for (const e of [{ ARIA_STREAM_RPC_HTTP_URL: H }, { RPC_RELAY_ENABLED: "true" }, { RPC_RELAY_ENABLED: "true", ARIA_STREAM_RPC_HTTP_URL: "http://evil.example/?k=" + KEY }]) {
  const c = dis(e as any);
  if (!c.enabled && c.reason.includes(KEY)) check("disabled reason never echoes a value", false);
}
check("disabled reasons never echo a value", true);
const tb = new TokenBucket(2, 4, 0);
check("TokenBucket: burst, then deny, then refill", tb.canTake(4, 0) && (tb.take(4), !tb.canTake(1, 0)) && tb.canTake(2, 1000));

await relay.close();
await new Promise<void>((r2) => upstream.close(() => r2()));
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
