import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Packaged-engine build identity and spawn-time compatibility gate (hosted
 * PAPER engine, Task 7).
 *
 * THE PROBLEM THIS CLOSES: `/healthz` used to report `ok: true` while
 * `engineSha` was honestly `null`, because nothing put any aria-engine code
 * into the container. A green `/healthz` therefore proved the control plane
 * was alive and proved NOTHING about whether hosted PAPER could run. This
 * module makes the engine's presence and exact version a separately reported,
 * separately verifiable fact.
 *
 * TWO INDEPENDENT SOURCES, deliberately:
 *   1. `ARIA_ENGINE_COMMIT_SHA` (env) — baked into the image by the
 *      Dockerfile's final stage. This is what the CONTROL PLANE believes it
 *      shipped. Same ARG/ENV pattern already used for RAILWAY_GIT_COMMIT_SHA.
 *   2. `<engineRepoPath>/.engine-sha` (file) — written by the Dockerfile's
 *      engine builder stage, next to the code that will actually execute.
 *      This is what is ACTUALLY on disk.
 * Comparing them is the whole point: a single source could not detect drift
 * between "the image the control plane thinks it is" and "the engine tree
 * that got copied in".
 *
 * FAIL-CLOSED, three layers:
 *   • Docker BUILD time — the builder stage refuses a non-40-char-hex pin and
 *     dies if the checked-out HEAD != the requested SHA, or if the tree has no
 *     src/cli.ts / no ARIA_RUNTIME_DIR support. A bad image is never produced.
 *   • /healthz — `engine.available` / `engine.compatible` / `fleet.available`
 *     report false rather than letting `ok: true` imply a working engine.
 *   • spawnTenant() — rejects with a clear error instead of spawning into a
 *     directory that does not exist or holds the wrong engine version.
 *
 * LOCAL DEV is explicitly not broken by any of this: with
 * `ARIA_ENGINE_COMMIT_SHA` unset (the sibling-checkout case), the engine is
 * "present but unpinned" — usable, sha reported as null (never fabricated
 * from `git rev-parse` of a possibly-dirty working tree), `verified: false`.
 * Production (`NODE_ENV=production`) refuses that state: an unpinned engine in
 * production means the packaging step did not run, which is precisely the
 * condition this task exists to make impossible to deploy silently.
 */

export const ENGINE_SHA_MARKER_FILE = ".engine-sha";

export interface EngineIdentity {
  /** Is there a usable engine tree at `engineRepoPath` (directory + src/cli.ts)? */
  available: boolean;
  /**
   * The engine's exact 40-char commit SHA, or `null` when it cannot be known
   * honestly (unpackaged local dev, or a packaged tree whose marker is
   * missing). NEVER a guess, never a branch name, never "unknown" dressed up
   * as a SHA.
   */
  sha: string | null;
  /** PAPER is the only mode this program ships. Constant, not inferred. */
  mode: "paper";
  /**
   * True only when the control plane's expected SHA and the on-disk marker
   * both exist AND match. False on any mismatch, and false (with
   * `verified: false`) in unpinned local dev — an unverifiable engine is
   * never reported as compatible.
   */
  compatible: boolean;
  /** Was a real pin-vs-marker comparison actually performed? Distinguishes "checked and matched" from "nothing to check". */
  verified: boolean;
  /** Absolute-or-configured path the engine was resolved at. Useful in an error message; contains no secret. */
  enginePath: string;
  /** Human-readable reason when `available`/`compatible` is false. `null` when everything is fine. Never contains a secret. */
  reason: string | null;
}

/** What the control plane believes it packaged. `undefined` in unpinned local dev. */
export function expectedEngineSha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.ARIA_ENGINE_COMMIT_SHA?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** What is actually on disk next to the packaged engine. `undefined` if unpackaged or unreadable. */
export function readEngineShaMarker(engineRepoPath: string): string | undefined {
  try {
    const v = readFileSync(path.join(engineRepoPath, ENGINE_SHA_MARKER_FILE), "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

const SHA40 = /^[0-9a-f]{40}$/;

export function resolveEngineIdentity(
  engineRepoPath: string,
  env: NodeJS.ProcessEnv = process.env,
): EngineIdentity {
  const base: Omit<EngineIdentity, "available" | "sha" | "compatible" | "verified" | "reason"> = {
    mode: "paper",
    enginePath: engineRepoPath,
  };

  // 1. Is there an engine tree at all? `src/cli.ts` specifically, not just the
  //    directory: an empty or wrong directory must not read as "available".
  if (!existsSync(engineRepoPath) || !existsSync(path.join(engineRepoPath, "src", "cli.ts"))) {
    return {
      ...base,
      available: false,
      sha: null,
      compatible: false,
      verified: false,
      reason: `no aria-engine checkout at ${engineRepoPath} (expected src/cli.ts) — the image was built without the engine packaging stage, or ARIA_ENGINE_REPO_PATH points somewhere wrong`,
    };
  }

  const expected = expectedEngineSha(env);
  const marker = readEngineShaMarker(engineRepoPath);
  const isProduction = (env.NODE_ENV ?? "").trim() === "production";

  // 2. Unpinned: no expected SHA from the image. Fine locally, fatal in prod.
  if (!expected) {
    if (isProduction) {
      return {
        ...base,
        available: false,
        sha: marker ?? null,
        compatible: false,
        verified: false,
        reason:
          "ARIA_ENGINE_COMMIT_SHA is not set in a production container — the engine packaging build step did not run, so the engine version cannot be verified. Refusing to report a usable engine.",
      };
    }
    return {
      ...base,
      available: true,
      sha: marker && SHA40.test(marker) ? marker : null,
      compatible: false,
      verified: false,
      reason:
        "unpinned local dev checkout (ARIA_ENGINE_COMMIT_SHA unset) — engine is usable but its version is not verified against a packaged pin",
    };
  }

  if (!SHA40.test(expected)) {
    return {
      ...base,
      available: false,
      sha: null,
      compatible: false,
      verified: true,
      reason: `ARIA_ENGINE_COMMIT_SHA is not an exact 40-char lowercase hex SHA (got '${expected}')`,
    };
  }

  // 3. Pinned but the on-disk marker is missing — the two sources disagree by
  //    omission. Treat as incompatible, not as "probably fine".
  if (!marker) {
    return {
      ...base,
      available: false,
      sha: null,
      compatible: false,
      verified: true,
      reason: `expected engine ${expected} but ${path.join(engineRepoPath, ENGINE_SHA_MARKER_FILE)} is missing or empty — the packaged tree carries no build identity`,
    };
  }

  if (marker !== expected) {
    return {
      ...base,
      available: false,
      sha: marker,
      compatible: false,
      verified: true,
      reason: `packaged engine SHA mismatch: control plane expects ${expected}, on-disk marker says ${marker}`,
    };
  }

  return { ...base, available: true, sha: marker, compatible: true, verified: true, reason: null };
}

/** Thrown by `spawnTenant()` when the packaged engine fails its build-identity check. Typed so the Telegram handler can show a clear operational message instead of a generic spawn error. */
export class EngineIdentityError extends Error {
  constructor(
    readonly clientId: string,
    readonly identity: EngineIdentity,
  ) {
    super(
      `refusing to spawn tenant ${clientId}: packaged engine failed verification — ${identity.reason ?? "unknown reason"}`,
    );
    this.name = "EngineIdentityError";
  }
}
