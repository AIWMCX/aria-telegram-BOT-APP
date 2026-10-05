import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTenantEnv, TENANT_ENV_ALLOWLIST, TenantProcess } from "./tenant-process.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

// Every control-plane secret name that exists in production. Values are DUMMY.
const DUMMY_SECRETS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "dummy-bot-token-123456:AAAA-not-real",
  TELEGRAM_WEBHOOK_SECRET: "dummy-webhook-secret-not-real",
  DATABASE_URL: "postgres://user:dummy-password@localhost:5432/db",
  ARIA_ENTITLEMENT_PRIVATE_D: "dummy-entitlement-private-not-real",
  ARIA_LICENSE_PRIVATE_D: "dummy-license-private-not-real",
  STRIPE_SECRET_KEY: "sk_test_dummy_not_real",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy_not_real",
  RESEND_API_KEY: "re_dummy_not_real",
  ARIA_ENGINE_GIT_TOKEN: "dummy-git-token-not-real",
};

// ── 1. Pure function ──────────────────────────────────────────────────────
const parent: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/x",
  NODE_ENV: "production",
  SystemRoot: "C:\\Windows", // mixed case, as on Windows
  ...DUMMY_SECRETS,
  SOME_OTHER_VAR: "should-not-pass",
};
const env = buildTenantEnv(parent, undefined, "/data/tenants/abc/.aria");
check("allow-listed basics are passed (PATH, HOME, NODE_ENV)", env.PATH === "/usr/bin" && env.HOME === "/home/x" && env.NODE_ENV === "production");
check("allow-list match is case-insensitive (SystemRoot)", env.SystemRoot === "C:\\Windows");
check("ARIA_RUNTIME_DIR is set to the tenant directory", env.ARIA_RUNTIME_DIR === "/data/tenants/abc/.aria");
for (const name of Object.keys(DUMMY_SECRETS)) {
  check(`secret ${name} is NOT passed to a tenant`, !(name in env));
}
check("unlisted ordinary variables are not passed either", !("SOME_OTHER_VAR" in env));
check("no value of any dummy secret appears anywhere in the built env", !Object.values(env).some((v) => Object.values(DUMMY_SECRETS).includes(v)));

let threw = false;
try { buildTenantEnv(parent, { ARIA_FOO_TOKEN: "x" }, "/r"); } catch { threw = true; }
check("a secret-looking extraEnv key is refused", threw);
threw = false;
try { buildTenantEnv(parent, { DATABASE_URL: "x" }, "/r"); } catch { threw = true; }
check("DATABASE_URL via extraEnv is refused", threw);
const withExtra = buildTenantEnv(parent, { ARIA_TENANT_LABEL: "t1" }, "/r");
check("a harmless extraEnv key is passed through", withExtra.ARIA_TENANT_LABEL === "t1");
check("the allow-list itself contains no secret-looking names", TENANT_ENV_ALLOWLIST.every((k) => !/(TOKEN|SECRET|PASSWORD|PRIVATE|DATABASE|KEY)/i.test(k)));

// Test-only prefix passthrough: forwards FAKE_* but can never forward a secret or accept a loose prefix.
const withFake = buildTenantEnv({ ...parent, FAKE_CRASH_AFTER_MS: "50", FAKE_SECRET_TOKEN: "dummy" }, undefined, "/r", ["FAKE_"]);
check("prefix passthrough forwards FAKE_* control variables", withFake.FAKE_CRASH_AFTER_MS === "50");
check("prefix passthrough never forwards a secret-looking name even under a matching prefix", !("FAKE_SECRET_TOKEN" in withFake));
check("prefix passthrough still blocks every real secret", Object.keys(DUMMY_SECRETS).every((k) => !(k in withFake)));
check("without a prefix FAKE_* is not forwarded", !("FAKE_CRASH_AFTER_MS" in buildTenantEnv({ ...parent, FAKE_CRASH_AFTER_MS: "50" }, undefined, "/r")));
for (const bad of ["", "_", "F_", "fake_", "FAKE", "FAKE_X*", "A_B_"]) {
  let rejected = false;
  try { buildTenantEnv(parent, undefined, "/r", [bad]); } catch { rejected = true; }
  check(`loose/invalid prefix ${JSON.stringify(bad)} is rejected`, rejected);
}

// ── 2. Real child process: what does it ACTUALLY see? ────────────────────
async function realSpawn(): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(DUMMY_SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-env-"));
  try {
    const runtimeDir = path.join(dir, "rt");
    const proc = new TenantProcess({
      clientId: "env-test-tenant",
      command: process.execPath,
      args: ["-e", "console.log('ENVDUMP ' + JSON.stringify(process.env)); console.log('paper engine started');"],
      cwd: dir,
      runtimeDir,
      logDir: path.join(dir, "logs"),
      readyMarker: "paper engine started",
    });
    await new Promise<void>((resolve) => proc.onEvent((e) => { if (e.type === "exit") resolve(); }));
    await new Promise((r) => setTimeout(r, 100));
    const log = fs.readFileSync(proc.logPath, "utf8");
    const line = log.split(/\r?\n/).find((l) => l.startsWith("ENVDUMP "));
    check("the real child printed its environment", Boolean(line));
    const seen = line ? (JSON.parse(line.slice("ENVDUMP ".length)) as Record<string, string>) : {};
    const seenKeys = Object.keys(seen).map((k) => k.toUpperCase());
    for (const name of Object.keys(DUMMY_SECRETS)) {
      check(`REAL child does not see ${name}`, !seenKeys.includes(name.toUpperCase()));
    }
    check("no dummy secret VALUE appears in the real child's log file", !Object.values(DUMMY_SECRETS).some((v) => log.includes(v)));
    check("REAL child sees ARIA_RUNTIME_DIR", seen.ARIA_RUNTIME_DIR === runtimeDir);
    check("REAL child still has PATH (it can start)", seenKeys.includes("PATH"));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the log briefly */ }
  }
}

await realSpawn();

if (failures > 0) {
  console.error(`\n❌ ${failures} FAILED`);
  process.exit(1);
}
console.log("\n✅ ALL TESTS PASSED");
