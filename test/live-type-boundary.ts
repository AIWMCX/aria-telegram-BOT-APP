/**
 * LIVE 0.1 — proves the quoted/realized money boundary is enforced by the
 * COMPILER, not only at runtime.
 *
 * The owner's constraint is that the types must make it structurally
 * impossible for a future author to treat a quoted/estimated amount as a
 * real/reconciled one. A runtime check alone cannot deliver that: it fires
 * after the wrong code was written, shipped and run. This test compiles a
 * fixture full of exactly those mistakes and asserts TypeScript REJECTS
 * every one of them.
 *
 * It is a negative test, so it must also guard against passing vacuously:
 * it asserts the fixture file actually exists, was actually compiled, and
 * that each numbered case produced its own diagnostic.
 *
 * Run: npx tsx test/live-type-boundary.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

let failures = 0;
function check(name: string, condition: boolean) {
  console.log(condition ? `✅ ${name}` : `❌ ${name}`);
  if (!condition) failures++;
}

const FIXTURE = "test/negative-types/quoted-is-not-realized.ts";
check("the negative fixture exists", fs.existsSync(FIXTURE));

let output = "";
let compiled = true;
try {
  execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--skipLibCheck", FIXTURE], { encoding: "utf8", shell: true });
} catch (err) {
  compiled = false;
  const e = err as { stdout?: string; stderr?: string };
  output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}

check("the fixture does NOT compile — the boundary is a compile error, not a convention", compiled === false);
check("the compiler actually produced diagnostics (not an empty failure)", /error TS\d+/.test(output));

// Each case must fail on its OWN line, so a single broad error cannot mask
// the others and make this test pass for the wrong reason.
const caseLines = fs.readFileSync(FIXTURE, "utf8").split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => /^export const case/.test(line))
  .map(({ n }) => n);

check("the fixture declares all 7 negative cases", caseLines.length === 7);

const erroredLines = new Set(
  [...output.matchAll(/quoted-is-not-realized\.ts\((\d+),\d+\)/g)].map((m) => Number(m[1])),
);
const missed = caseLines.filter((n) => !erroredLines.has(n));
check(`every negative case is individually rejected by the compiler${missed.length ? ` (missed lines: ${missed.join(", ")})` : ""}`,
  missed.length === 0);

console.log(failures === 0 ? "\n✅ live-type-boundary: all checks passed" : `\n❌ live-type-boundary: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
