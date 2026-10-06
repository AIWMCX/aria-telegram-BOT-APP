/**
 * Bot-level test for the admin-only /fleet_stop_all command: a non-admin is
 * refused and nothing is stopped; the admin stops tenants and the reply
 * reports stopped/failed counts and the FLEET_ENABLED=false hint.
 *
 * The bot is driven through grammy's real handleUpdate() with the outgoing
 * Telegram API stubbed by a transformer (no network).
 *
 * Run: npx tsx test/fleet-stop-all-bot.ts
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const TEST_DB = "./data/fleet-stop-all-bot-test.db";
for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(TEST_DB + suffix)) fs.rmSync(TEST_DB + suffix);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.TELEGRAM_BOT_TOKEN = "1234567890:TEST_TOKEN_NOT_REAL_xxxxxxxxxxxxxxxxxxxx";
process.env.PUBLIC_URL = "http://localhost:8080";
process.env.RESEND_API_KEY = "re_test_fake_key_xxxxxxxxxxxxxxxxxxxx";
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ARIA_LICENSE_PRIVATE_D = (privateKey.export({ format: "jwk" }) as { d: string }).d;
process.env.ARIA_LICENSE_PUBLIC_X = (publicKey.export({ format: "jwk" }) as { x: string }).x;
const { publicKey: ep, privateKey: ek } = generateKeyPairSync("ed25519");
process.env.ARIA_ENTITLEMENT_PRIVATE_D = (ek.export({ format: "jwk" }) as { d: string }).d;
process.env.ARIA_ENTITLEMENT_PUBLIC_X = (ep.export({ format: "jwk" }) as { x: string }).x;
process.env.DB_PATH = TEST_DB;
process.env.LOG_LEVEL = "error";
process.env.ADMIN_TELEGRAM_CHAT_ID = "999";
delete process.env.DATABASE_URL;

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

const { bot } = await import("../src/bot.js");
const { fleetManager } = await import("../src/fleet/instance.js");

const sent: string[] = [];
bot.botInfo = { id: 1, is_bot: true, first_name: "t", username: "t_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
bot.api.config.use(async (_prev, method, payload) => {
  if (method === "sendMessage") sent.push(String((payload as { text?: string }).text));
  return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as never;
});

let calls = 0;
let nextResult = { count: 2, failed: 0 };
(fleetManager as unknown as { stopAllTenants: () => Promise<{ count: number; failed: number }> }).stopAllTenants = async () => {
  calls++;
  return nextResult;
};

let updateId = 1;
async function say(fromId: number, text: string) {
  sent.length = 0;
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private", first_name: "x" },
      from: { id: fromId, is_bot: false, first_name: "x" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  } as never);
}

await say(111, "/fleet_stop_all");
check("BOT: non-admin /fleet_stop_all is refused with the admin-only message", sent.length === 1 && /administrator only/i.test(sent[0]!));
check("BOT: non-admin does NOT trigger stopAllTenants", calls === 0);

await say(999, "/fleet_stop_all");
check("BOT: admin /fleet_stop_all calls stopAllTenants once", calls === 1);
check("BOT: admin reply reports the stopped count", sent.length === 1 && /Stopped 2 hosted PAPER tenants/.test(sent[0]!));
check("BOT: admin reply says users can still /paper_start unless FLEET_ENABLED=false", /\/paper_start/.test(sent[0] ?? "") && /FLEET_ENABLED=false/.test(sent[0] ?? ""));
check("BOT: no failure line when nothing failed", !/could NOT/.test(sent[0] ?? ""));

nextResult = { count: 1, failed: 2 };
await say(999, "/fleet_stop_all");
check("BOT: reply reports how many failed", /2 could NOT be fully stopped/.test(sent[0] ?? "") && /Stopped 1 hosted PAPER tenant and/.test(sent[0] ?? ""));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall fleet_stop_all bot checks passed");
process.exit(0);
