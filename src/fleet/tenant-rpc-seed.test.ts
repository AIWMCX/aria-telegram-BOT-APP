import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateTenantToken, reconcileTenantRpcSync, relayUrl, RPC_SEED_SIDECAR, RPC_TOKEN_FILE } from "./tenant-rpc-seed.js";
import { buildTenantEnv } from "./tenant-process.js";
import { newTenantToken } from "../rpc-relay/relay.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

const PUBLIC = "https://api.mainnet-beta.solana.com";
const KEY = "FAKEHELIUSKEY-9f3a71c2d8";
function tenantDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpcseed-"));
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ schemaVersion: 1, rpc: { url: PUBLIC, fallbackUrls: [], timeoutMs: 5000 }, paper: {}, market: { kind: "synthetic" } }, null, 2), { mode: 0o600 });
  return d;
}
const readCfg = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8"));

const tok = newTenantToken();
check("generated tokens are unguessable (256-bit, url-safe)", /^[A-Za-z0-9_-]{43}$/.test(tok) && newTenantToken() !== tok);

// token persistence
{
  const d = tenantDir();
  const t1 = getOrCreateTenantToken(d, newTenantToken)!;
  const t2 = getOrCreateTenantToken(d, () => "should-not-be-used-should-not-be-used")!;
  check("tenant token is persisted and stable across calls", !!t1 && t1 === t2);
  if (process.platform !== "win32") check("token file is mode 0600", (fs.statSync(path.join(d, RPC_TOKEN_FILE)).mode & 0o777) === 0o600);
  else check("(token file mode 0600 is enforced by writeFileSync mode; not checkable on Windows)", true);
}

// seeding ON
const url = relayUrl(8899, tok);
check("relay URL is http loopback with the tenant token in the path", url === `http://127.0.0.1:8899/rpc/${tok}`);
{
  const d = tenantDir();
  check("seed ON: rpc.url set to the relay URL", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url }) === "enabled" && readCfg(d).rpc.url === url);
  const cfg = readCfg(d);
  check("seed ON touches only rpc.url (everything else unchanged)", cfg.rpc.timeoutMs === 5000 && cfg.market.kind === "synthetic" && cfg.schemaVersion === 1);
  check("seed ON is idempotent", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url }) === "unchanged");
  check("sidecar records the previous URL and lives outside config.json", JSON.parse(fs.readFileSync(path.join(d, RPC_SEED_SIDECAR), "utf8")).prevUrl === PUBLIC && !("prevUrl" in cfg));
  check("port change re-points the URL but keeps the ORIGINAL previous value", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: relayUrl(9100, tok) }) === "enabled" && JSON.parse(fs.readFileSync(path.join(d, RPC_SEED_SIDECAR), "utf8")).prevUrl === PUBLIC);
  // seeding OFF
  check("seed OFF: rpc.url reverts to the previous value and the sidecar is removed", reconcileTenantRpcSync({ runtimeDir: d, enabled: false }) === "disabled" && readCfg(d).rpc.url === PUBLIC && !fs.existsSync(path.join(d, RPC_SEED_SIDECAR)));
  check("seed OFF again is a no-op", reconcileTenantRpcSync({ runtimeDir: d, enabled: false }) === "unchanged");
}
{
  const d = tenantDir();
  check("OFF never touches a tenant we did not seed", reconcileTenantRpcSync({ runtimeDir: d, enabled: false }) === "unchanged" && readCfg(d).rpc.url === PUBLIC);
}
{
  const d = tenantDir();
  reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url });
  const c = readCfg(d); c.rpc.url = "https://operator.example/rpc"; fs.writeFileSync(path.join(d, "config.json"), JSON.stringify(c));
  check("OFF leaves an operator-edited rpc.url alone", reconcileTenantRpcSync({ runtimeDir: d, enabled: false }) === "disabled" && readCfg(d).rpc.url === "https://operator.example/rpc");
}
{
  const d = tenantDir();
  reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url });
  const c = readCfg(d); c.rpc.url = "https://operator.example/rpc"; fs.writeFileSync(path.join(d, "config.json"), JSON.stringify(c));
  check("ON does not overwrite an operator-edited rpc.url", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url }) === "unchanged" && readCfg(d).rpc.url === "https://operator.example/rpc");
}
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpcseed-"));
  check("missing config.json is deferred (engine creates it, next spawn seeds)", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url }) === "deferred");
  fs.writeFileSync(path.join(d, "config.json"), "{not json");
  check("unreadable config.json is deferred and not clobbered", reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url }) === "deferred" && fs.readFileSync(path.join(d, "config.json"), "utf8") === "{not json");
}

// the provider key can never get into a tenant's files or env
{
  const d = tenantDir();
  getOrCreateTenantToken(d, newTenantToken);
  reconcileTenantRpcSync({ runtimeDir: d, enabled: true, relayUrl: url });
  const all = fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n");
  check("no file in the tenant runtime dir contains the provider key", !all.includes(KEY));
  const env = buildTenantEnv({ PATH: "/bin", ARIA_STREAM_RPC_HTTP_URL: `https://h.example/?api-key=${KEY}`, RPC_RELAY_ENABLED: "true", RPC_RELAY_PORT: "8899" }, undefined, d);
  check("tenant env carries neither the stream URL nor any RPC_RELAY_* variable", !JSON.stringify(env).includes(KEY) && !("RPC_RELAY_ENABLED" in env) && !("ARIA_STREAM_RPC_HTTP_URL" in env));
}

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
