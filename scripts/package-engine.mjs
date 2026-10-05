#!/usr/bin/env node
/**
 * Deterministic aria-engine packaging (hosted PAPER engine, Task 7).
 *
 * ONE implementation, called from TWO places:
 *   • the Dockerfile's `engine` builder stage (production image build), and
 *   • scripts/packaged-engine-integration-test.mts (the local
 *     production-equivalent test).
 * Written as a shared script rather than inline `RUN` shell precisely so the
 * artifact the integration test exercises is produced by the SAME code that
 * produces the shipped image's artifact. Two hand-maintained copies of these
 * steps could silently drift, and a test against a drifted copy proves
 * nothing about the thing that ships.
 *
 * Guarantees:
 *   • Pinned to an EXACT 40-char lowercase hex commit SHA. Branch names,
 *     tags, and "latest" are refused before any network access happens.
 *   • The commit object is fetched BY SHA (`git fetch origin <sha>`), not by
 *     fetching a branch and hoping it still points there — so a rewritten or
 *     deleted upstream commit fails the build loudly instead of silently
 *     resolving to different code.
 *   • The checked-out HEAD is re-verified against the requested SHA AFTER
 *     checkout. Given (control-plane SHA A, engine SHA B), rebuilding
 *     reproduces the same (A, B) combination or fails.
 *   • FAIL-CLOSED throughout: every check `process.exit(1)`s. There is no
 *     path through this script that produces a partial or unverified
 *     artifact and reports success.
 *   • No aria-engine source is ever copied into this repository. The two
 *     repos stay separate; this solves distribution, not duplication.
 *
 * CREDENTIALS: aria-engine is private. A token may be supplied via the
 * ARIA_ENGINE_GIT_TOKEN env var (never a CLI arg — argv is visible in `ps`).
 * It is injected into the remote URL only for the fetch, the remote is then
 * removed, and `.git` is deleted entirely, so no credential survives into the
 * packaged tree or any shipped image layer. The token is never logged: every
 * message below prints the CLEAN url, never the authenticated one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const SHA40 = /^[0-9a-f]{40}$/;
const DEFAULT_URL = "https://github.com/AIWMCX/aria-engine.git";

function fatal(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// Redact any occurrence of the (secret) token from text before it is ever
// printed or thrown. Some git failure modes (TLS/proxy/curl errors) echo the
// full authenticated remote URL to stderr, unlike the common auth-failure
// case GitHub itself redacts — so this must not rely on git/GitHub behavior.
function redact(text, secret) {
  if (!secret) return text;
  return text.split(secret).join("***REDACTED***");
}

const sha = (arg("sha") ?? process.env.ARIA_ENGINE_COMMIT_SHA ?? "").trim();
const dest = arg("dest") ?? "/opt/aria-engine";
const url = (arg("url") ?? process.env.ARIA_ENGINE_GIT_URL ?? DEFAULT_URL).trim();
const token = (process.env.ARIA_ENGINE_GIT_TOKEN ?? "").trim();

// ── Preflight: refuse a bad pin before touching the network ─────────────────
// An unset ARG in Docker is the empty string, which would otherwise sail
// through to a confusing git error. This is the first fail-closed gate.
if (!SHA40.test(sha)) {
  fatal(
    `--sha / ARIA_ENGINE_COMMIT_SHA must be an exact 40-char lowercase hex commit SHA (got: ${JSON.stringify(sha)}). ` +
      `Branch names, tags and "latest" are refused by design — a mutable ref cannot produce a reproducible image.`,
  );
}

console.log(`[package-engine] pin=${sha}`);
console.log(`[package-engine] source=${url}`);
console.log(`[package-engine] dest=${dest}`);

// A pre-existing destination is removed rather than fetched into: a partially
// populated directory from a failed earlier run could otherwise contribute
// stale files to the "verified" artifact.
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const authUrl = token && url.startsWith("https://")
  ? url.replace("https://", `https://x-access-token:${token}@`)
  : url;

try {
  run("git", ["init", "-q", "."], dest);
  run("git", ["remote", "add", "origin", authUrl], dest);
  run("git", ["fetch", "-q", "--depth", "1", "origin", sha], dest);
  run("git", ["checkout", "-q", "FETCH_HEAD"], dest);
  run("git", ["remote", "remove", "origin"], dest);
} catch (err) {
  // git's stderr is captured (piped, not inherited) rather than let through
  // raw: some git failure modes (TLS/proxy/curl errors) echo the full
  // authenticated URL — including the token — to stderr, even in modes where
  // GitHub's own auth-failure redaction doesn't kick in. Redact the token out
  // of whatever came back before it is printed anywhere.
  const rawStderr = typeof err.stderr === "string" ? err.stderr : (err.stderr ?? "").toString("utf8");
  const safeStderr = redact(rawStderr, token);
  if (safeStderr.trim()) console.error(safeStderr.trim());
  // Remove the partial/failed destination BEFORE exiting: dest may already
  // contain a .git/config with the token embedded in the remote URL
  // (authUrl), and fatal() below calls process.exit(1) with no cleanup of
  // its own — leaving that credential-bearing directory on disk otherwise.
  rmSync(dest, { recursive: true, force: true });
  fatal(`git fetch of ${sha} from ${url} failed (transport or auth error; details above, if any, have been redacted of credentials)`);
}

// ── Post-checkout verification ──────────────────────────────────────────────
const actual = run("git", ["rev-parse", "HEAD"], dest).trim();
if (actual !== sha) fatal(`engine checkout SHA mismatch. requested=${sha} actual=${actual}`);

for (const rel of ["src/cli.ts", "src/runtime/paths.ts", "package.json"]) {
  if (!existsSync(path.join(dest, rel))) fatal(`packaged engine is missing ${rel} — not a usable aria-engine checkout`);
}

// The hosted fleet depends entirely on ARIA_RUNTIME_DIR for per-tenant
// isolation (aria-engine src/runtime/paths.ts). An engine without it would
// have every tenant share ~/.aria — silent cross-tenant state corruption, not
// a visible failure. Verified here so such a SHA can never be packaged.
const paths = run("node", ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(dest, "src/runtime/paths.ts"))},'utf8'))`]);
if (!paths.includes("ARIA_RUNTIME_DIR")) {
  fatal("packaged engine lacks the ARIA_RUNTIME_DIR multi-tenant override — refusing to package an engine that cannot isolate tenants");
}

// aria-engine declares ZERO runtime `dependencies` at this SHA — only
// devDependencies (tsx, typescript, @types/node). `--include=dev` is therefore
// REQUIRED, not an optimization: tsx is what actually executes src/cli.ts, so
// a production-only install would yield a tree that passes every check above
// and still cannot spawn a single tenant.
console.log("[package-engine] npm ci --include=dev");
// `npm.cmd` on Windows rather than `shell: true`: passing args through a shell
// concatenates rather than escapes them (Node DEP0190). Production builds run
// this on Linux where plain `npm` is correct; the branch exists only so the
// local production-equivalent test can produce a real artifact on Windows.
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
  cwd: dest,
  stdio: "inherit",
});

// Build-identity marker, written NEXT TO the code that will execute. This is
// the second of the two independent sources src/fleet/engine-identity.ts
// compares (the other is the image's ARIA_ENGINE_COMMIT_SHA env var).
writeFileSync(path.join(dest, ".engine-sha"), sha, "utf8");

// Remove git metadata last: it is not needed at runtime and its config still
// holds nothing sensitive (the remote was removed above), but deleting it
// removes any possibility of a credential-bearing URL reaching a shipped layer.
rmSync(path.join(dest, ".git"), { recursive: true, force: true });

console.log(`[package-engine] OK — verified engine ${sha} packaged at ${dest}`);
