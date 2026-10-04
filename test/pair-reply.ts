import { randomBytes } from "node:crypto";
import { formatPairReply } from "../src/pair-reply.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

// Real generator shape (src/engine-pairing.ts): randomBytes(20).toString("base64url").
function realShapedCode(): string {
  return randomBytes(20).toString("base64url");
}

// Codes that DO contain the characters the old esc() mangled.
const withUnderscore = "abcdEFGH_ijklMNOP0123456789";
const withDash = "abcdEFGH-ijklMNOP0123456789";
const withBoth = "ab_cd-EFGH_ijkl-MNOP0123456";

for (const code of [withUnderscore, withDash, withBoth]) {
  const text = formatPairReply(code, "12:34");
  check(`code "${code}" appears verbatim inside the code span`, text.includes(`\`aria pair ${code}\``));
  check(`no backslash anywhere in the reply for "${code}"`, !text.includes("\\"));
}

let allVerbatim = true;
let sawSpecial = 0;
for (let i = 0; i < 2000; i++) {
  const code = realShapedCode();
  if (/[_-]/.test(code)) sawSpecial++;
  const text = formatPairReply(code, "09:05");
  if (!text.includes(`\`aria pair ${code}\``) || text.includes("\\")) allVerbatim = false;
}
check("2000 real-shaped codes all render verbatim with no backslashes", allVerbatim);
check("the sample really exercised codes containing _ or - (sanity)", sawSpecial > 500);

for (const bad of ["", "short", "has space inside code", "back`tick_and_more_chars", "back\\slash_and_more_chars", "x".repeat(200)]) {
  let threw = false;
  try { formatPairReply(bad, "12:34"); } catch { threw = true; }
  check(`rejects malformed code ${JSON.stringify(bad.slice(0, 24))}`, threw);
}

const sample = formatPairReply(withBoth, "12:34");
check("reply still contains the expiry label", sample.includes("Expires 12:34 UTC"));
check("reply still tells the user how to get a fresh code", sample.includes("`/pair`"));

if (failures > 0) {
  console.error(`\n❌ ${failures} FAILED`);
  process.exit(1);
}
console.log("\n✅ ALL TESTS PASSED");
