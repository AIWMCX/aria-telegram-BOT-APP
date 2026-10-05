#!/usr/bin/env node
// Offline stub Solana JSON-RPC endpoint for the real-engine capacity run
// (scripts/real-engine-capacity-run.mts). Binds 127.0.0.1 only. Answers every
// method with an empty/null result so the engine's real discovery polling loop
// runs against zero candidates and NO external RPC is contacted. Counts
// requests and exposes them on GET /stats.
import http from "node:http";
const port = Number(process.argv[2] ?? 18899);
let total = 0;
const byMethod = {};
const answer = (m) => {
  total++;
  byMethod[m.method] = (byMethod[m.method] ?? 0) + 1;
  const result = m.method === "getSignaturesForAddress" ? [] : null;
  return { jsonrpc: "2.0", id: m.id ?? null, result };
};
http
  .createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ total, byMethod }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let out;
      try {
        const j = JSON.parse(body);
        out = Array.isArray(j) ? j.map(answer) : answer(j);
      } catch {
        out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`stub rpc on 127.0.0.1:${port}`));
