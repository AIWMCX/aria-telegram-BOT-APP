import fs from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "engine/src", "src/engine-auth.ts", "src/engine-store.ts", "public/app.js", "public/index.html"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
const forbidden = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(signTransaction|sendTransaction|sendRawTransaction|broadcastTransaction)\b/,
  /@solana\/(web3|wallet)/i,
  /Live mainnet execution/i,
  /Live Event Stream/i,
  /DEMO (BUY|SELL)/i,
];
const hits: string[] = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) hits.push(file);
}
if (hits.length) { console.error(`REAL1_CAPABILITY_SCAN_FAILED files=${[...new Set(hits)].join(",")}`); process.exit(1); }
console.log(`REAL1 capability scan passed files=${files.length}`);
