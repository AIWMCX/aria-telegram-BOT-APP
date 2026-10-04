/**
 * /healthz (liveness) stays 200 and gains a `postgres` block; /readyz
 * (readiness) is 503 when Postgres is configured but unreachable / not
 * migrated and 200 when Postgres is not configured or ready. Also proves a
 * dummy DATABASE_URL (recognisable password/user) never leaks.
 *
 * Postgres is simulated: a closed loopback port, and a minimal in-process
 * fake speaking just enough of the Postgres wire protocol to answer
 * `SELECT 1`. No real Postgres is used here.
 *
 * Run: npx tsx test/readyz.ts
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const TEST_DB = "./data/readyz-test.db";
if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(TEST_DB + suffix)) fs.rmSync(TEST_DB + suffix);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = privJwk.d;
process.env.ARIA_LICENSE_PUBLIC_X = pubJwk.x;
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";
const { publicKey: entPub, privateKey: entPriv } = generateKeyPairSync("ed25519");
process.env.ARIA_ENTITLEMENT_PRIVATE_D = (entPriv.export({ format: "jwk" }) as { d: string }).d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = (entPub.export({ format: "jwk" }) as { x: string }).x;

const MODE = process.argv[2] ?? "all";
const SECRET_PW = "DUMMY_PW_s3cr3t_zq81";
const SECRET_USER = "dummyuser_zq81";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}
const leaks = (txt: string) =>
  txt.includes(SECRET_PW) || txt.includes(SECRET_USER) || txt.includes("postgres://") || txt.includes("dummydb_test");

/** Minimal fake Postgres: trust auth, answers any simple Query with one row "1". */
function startFakePg(): Promise<net.Server> {
  const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const msg = (t: string, body: Buffer) => Buffer.concat([Buffer.from(t), i32(body.length + 4), body]);
  const ready = msg("Z", Buffer.from("I"));
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    socks.add(sock);
    let started = false;
    let buf = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0));
          started = true;
          sock.write(Buffer.concat([msg("R", i32(0)), ready]));
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
        const type = String.fromCharCode(buf[0]);
        buf = buf.subarray(1 + buf.readInt32BE(1));
        if (type === "Q") {
          const rowDesc = msg("T", Buffer.concat([i16(1), Buffer.from("?column?\0"), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)]));
          const row = msg("D", Buffer.concat([i16(1), i32(1), Buffer.from("1")]));
          sock.write(Buffer.concat([rowDesc, row, msg("C", Buffer.from("SELECT 1\0")), ready]));
        } else if (type === "X") sock.end();
      }
    });
  });
  (server as any).killAll = () => { for (const s of socks) s.destroy(); server.close(); };
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

function unusedPort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function scenarioNotConfigured() {
  delete process.env.DATABASE_URL;
  const { app } = await import("../src/server.js");
  const h = await app.request("/healthz");
  const hb = (await h.json()) as any;
  check("not configured: /healthz 200 ok:true with postgres block",
    h.status === 200 && hb.ok === true && hb.postgres?.configured === false && hb.postgres?.ready === false && hb.postgres?.migrations === "skipped");
  check("not configured: /healthz keeps existing fields",
    typeof hb.uptime === "number" && "leads" in hb && "paymentsEnabled" in hb && "release" in hb);
  const r = await app.request("/readyz");
  const rb = (await r.json()) as any;
  check("not configured: /readyz 200 ready:true", r.status === 200 && rb.ready === true && rb.sqlite === true);
}

async function scenarioUnreachable() {
  const port = await unusedPort();
  process.env.DATABASE_URL = `postgres://${SECRET_USER}:${SECRET_PW}@127.0.0.1:${port}/dummydb_test`;
  const { app } = await import("../src/server.js");
  const h = await app.request("/healthz");
  const htxt = await h.text();
  const hb = JSON.parse(htxt);
  check("unreachable: /healthz STILL 200 ok:true (liveness)", h.status === 200 && hb.ok === true);
  check("unreachable: postgres block configured:true ready:false migrations:unknown",
    hb.postgres?.configured === true && hb.postgres?.ready === false && hb.postgres?.migrations === "unknown");
  const r = await app.request("/readyz");
  const rtxt = await r.text();
  check("unreachable: /readyz 503", r.status === 503 && JSON.parse(rtxt).ready === false);
  check("unreachable: no secret/connection-string leak in /healthz", !leaks(htxt));
  check("unreachable: no secret/connection-string leak in /readyz", !leaks(rtxt));
}

async function scenarioReachable() {
  const fake = await startFakePg();
  const port = (fake.address() as net.AddressInfo).port;
  process.env.DATABASE_URL = `postgres://${SECRET_USER}:${SECRET_PW}@127.0.0.1:${port}/dummydb_test`;
  const { app } = await import("../src/server.js");
  const { setMigrationOutcome, resetPgHealthStateForTests } = await import("../src/pg-health.js");
  resetPgHealthStateForTests();

  let r = await app.request("/readyz");
  check("reachable but migrations not yet run (unknown): /readyz 503", r.status === 503);
  resetPgHealthStateForTests();
  setMigrationOutcome("failed");
  r = await app.request("/readyz");
  check("reachable but migrations failed: /readyz 503", r.status === 503 && ((await r.json()) as any).postgres.migrations === "failed");
  resetPgHealthStateForTests();
  setMigrationOutcome("up-to-date");
  r = await app.request("/readyz");
  const rtxt = await r.text();
  const rb = JSON.parse(rtxt);
  check("reachable + up-to-date: /readyz 200 ready:true",
    r.status === 200 && rb.ready === true && rb.postgres.ready === true && rb.postgres.migrations === "up-to-date");
  const h = await app.request("/healthz");
  const htxt = await h.text();
  check("reachable: /healthz 200 with postgres ready:true", h.status === 200 && JSON.parse(htxt).postgres.ready === true);
  check("reachable: no secret/connection-string leak", !leaks(htxt) && !leaks(rtxt));

  // Cache: DB goes away, answer must not flip within the TTL (polling cannot hammer the DB)...
  (fake as any).killAll();
  r = await app.request("/readyz");
  check("probe result cached within TTL", r.status === 200);
  // ...but after the cache is dropped a fresh probe sees the outage.
  resetPgHealthStateForTests();
  setMigrationOutcome("up-to-date");
  r = await app.request("/readyz");
  check("after outage + cache expiry: /readyz 503 again", r.status === 503);
}

async function main() {
  // The module graph reads DATABASE_URL at import time, so each scenario gets its own process.
  if (MODE === "all") {
    const { spawnSync } = await import("node:child_process");
    for (const m of ["not-configured", "unreachable", "reachable"]) {
      const res = spawnSync(process.execPath, ["--import", "tsx", "test/readyz.ts", m], { stdio: "inherit" });
      if (res.status !== 0) failures++;
    }
  } else if (MODE === "not-configured") await scenarioNotConfigured();
  else if (MODE === "unreachable") await scenarioUnreachable();
  else if (MODE === "reachable") await scenarioReachable();
  console.log(failures === 0 ? `ALL PASSED (${MODE})` : `${failures} FAILED (${MODE})`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
