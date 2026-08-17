import assert from "node:assert/strict";
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "https://example.com";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = "d".repeat(43);
process.env.ARIA_LICENSE_PUBLIC_X = "x".repeat(43);
const { EngineStore, hashCredential } = await import("../src/engine-store.js") as typeof import("../src/engine-store.js");
type PoolLike = import("../src/engine-store.js").PoolLike;

const queries: Array<{ text: string; values: unknown[] }> = [];
const fakePool: PoolLike = {
  async query<T = any>(text: string, values: unknown[] = []) {
    queries.push({ text, values });
    return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] } as any;
  },
};
const store = new EngineStore(fakePool, "test-pepper");
assert.equal(hashCredential("credential", "test-pepper"), hashCredential("credential", "test-pepper"));
assert.notEqual(hashCredential("credential", "test-pepper"), "credential");
await assert.rejects(() => store.appendEngineEvents("device", Array.from({ length: 101 }, (_, i) => ({ id: String(i), kind: "stopped", occurredAt: new Date().toISOString(), message: "x", paperOnly: true })) as any), /too large/);
await store.appendCommand(42, "device", { id: "cmd", type: "stop", payload: null, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString() });
assert.match(queries.at(-1)!.text, /user_id = \$2/);
assert.match(queries.at(-1)!.text, /status = 'active'/);
await store.revokeDevice(42, "device");
assert.match(queries.at(-1)!.text, /user_id = \$2/);
console.log("engine store contract tests passed");
