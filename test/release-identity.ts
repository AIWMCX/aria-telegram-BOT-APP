/**
 * Proves /healthz's `release` block (added for the 2026-09-19
 * release-integrity charter — see src/release.ts) returns real values when
 * the sourcing env vars are present, falls back to explicit "unknown"
 * strings rather than crashing or fabricating a value when they are not,
 * and never leaks anything sensitive (secret env var names/values, full
 * `process.env`, stack traces).
 *
 * Run: npx tsx test/release-identity.ts
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const TEST_DB = "./data/release-identity-test.db";
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
const entPrivJwk = entPriv.export({ format: "jwk" }) as { d: string; x: string };
const entPubJwk = entPub.export({ format: "jwk" }) as { x: string };
process.env.ARIA_ENTITLEMENT_PRIVATE_D = entPrivJwk.d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = entPubJwk.x;

// Deliberately real-looking so we can prove the endpoint reflects them —
// this is exactly what Railway would set (via ARG->ENV in the Dockerfile)
// or a build-time file would provide in production.
process.env.APP_COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";
process.env.APP_GIT_BRANCH = "main";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

async function main() {
  const { app } = await import("../src/server.js");

  const res = await app.request("/healthz");
  check("/healthz returns 200", res.status === 200);
  const body = (await res.json()) as any;

  check("ok: true", body.ok === true);
  check("release block present", typeof body.release === "object" && body.release !== null);
  check("controlPlaneSha reflects APP_COMMIT_SHA env var", body.release.controlPlaneSha === process.env.APP_COMMIT_SHA);
  check("branch reflects APP_GIT_BRANCH env var", body.release.branch === "main");
  check("mode is paper", body.release.mode === "paper");
  check("engineSha is explicitly null (no fabricated value — see Task 1 finding)", body.release.engineSha === null);
  check("buildTime is a non-empty string (real value or explicit 'unknown', never undefined)", typeof body.release.buildTime === "string" && body.release.buildTime.length > 0);
  check("releaseId is a non-empty string", typeof body.release.releaseId === "string" && body.release.releaseId.length > 0);

  // Never leaks secrets: none of the actual secret env var VALUES this
  // process holds should appear anywhere in the serialized response.
  const serialized = JSON.stringify(body);
  const secretValues = [
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.RESEND_API_KEY!,
    process.env.ARIA_LICENSE_PRIVATE_D!,
    process.env.ARIA_ENTITLEMENT_PRIVATE_D!,
  ];
  check("response does not contain any secret env var value", secretValues.every((v) => !serialized.includes(v)));
  // Never leaks raw process.env (e.g. accidentally spreading it into the response).
  check("response does not include unrelated env var names as keys", !("TELEGRAM_BOT_TOKEN" in body) && !("TELEGRAM_BOT_TOKEN" in body.release));

  // Falls back to "unknown" rather than crashing when NONE of the sourcing
  // env vars/files are present. Module-level consts in src/release.ts are
  // computed once at import time, so this needs a genuinely fresh process
  // (not just deleting keys from process.env in this one) — spawn tsx in a
  // clean child env and read its stdout.
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", "import('./src/release.js').then(m => console.log(JSON.stringify(m.releaseInfo())))"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        APP_COMMIT_SHA: "",
        RAILWAY_GIT_COMMIT_SHA: "",
        APP_GIT_BRANCH: "",
        RAILWAY_GIT_BRANCH: "",
        APP_BUILD_TIME: "",
      },
    },
  );
  let fallbackInfo: any = null;
  try { fallbackInfo = JSON.parse(child.stdout.trim().split("\n").pop() ?? "null"); } catch { /* leave null, checks below fail loudly */ }
  check("no sourcing env vars present → controlPlaneSha falls back to explicit 'unknown' (no crash, no fabrication)", fallbackInfo?.controlPlaneSha === "unknown");
  check("no sourcing env vars present → engineSha still null", fallbackInfo?.engineSha === null);
  check("child process did not crash computing release info with no env vars set", child.status === 0);

  console.log(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} TEST(S) FAILED`}`);

  const { db } = await import("../src/db.js");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(TEST_DB + suffix, { force: true }); } catch { /* best-effort cleanup, not test-critical */ }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
