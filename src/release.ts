import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build/release identity — added per the production-recovery release-integrity
 * charter (2026-09-19): "A GitHub commit is not deployed merely because it
 * exists... ARIA may be called current only when INTENDED_RELEASE_SHA =
 * origin/main SHA = Railway deployment source SHA = running application's
 * reported build SHA." This module is the "running application's reported
 * build SHA" side of that chain — /healthz below is what a smoke test or a
 * human reads to close the loop after a deploy.
 *
 * Sourcing, in priority order:
 *   1. `APP_COMMIT_SHA` — an explicit override, set as a Railway service
 *      variable if ever wired up. Not present on the production service as
 *      of this writing (verified via the Railway MCP `list-variables` call —
 *      see docs/ARIA_PRODUCTION_RELEASE_MANIFEST.md).
 *   2. `RAILWAY_GIT_COMMIT_SHA` — Railway's own automatically-provided git
 *      metadata. Per Railway's docs this is available to a Dockerfile build
 *      as a BUILD ARG (not a runtime env var) unless the Dockerfile declares
 *      `ARG RAILWAY_GIT_COMMIT_SHA` and promotes it with `ENV` — which this
 *      repo's Dockerfile now does (see the ARG/ENV lines near the top).
 *      `list-variables` against the live service does NOT show this name,
 *      which is consistent with it being a build-arg-only mechanism that
 *      was never promoted before this change — i.e. this is genuinely new
 *      wiring, not a value that was already flowing and just unread.
 *   3. `.build-time`/`.build-sha` files written during the Docker build
 *      (belt-and-suspenders: works even if Railway's build-arg injection
 *      ever changes shape, and gives a real value for local `docker build`).
 *   4. `"unknown"` — explicit, never fabricated. A missing/placeholder value
 *      must never be presented as a real SHA.
 *
 * IMPORTANT — this file intentionally has NO opinion on the ENGINE's build
 * identity (`engineSha`). As of this writing there is no mechanism that
 * provisions any `aria-engine` artifact into this service's container at
 * all (see the Task 1 finding in the release manifest doc), so there is
 * nothing honest to report there yet. Callers must pass `null`/"unknown"
 * for that field rather than inventing one.
 */

function readBuildFile(name: string): string | undefined {
  try {
    const value = readFileSync(path.join(process.cwd(), name), "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export const APP_COMMIT_SHA: string =
  firstNonEmpty(process.env.APP_COMMIT_SHA, process.env.RAILWAY_GIT_COMMIT_SHA, readBuildFile(".build-sha")) ??
  "unknown";

export const BUILD_TIME: string =
  firstNonEmpty(process.env.APP_BUILD_TIME, readBuildFile(".build-time")) ?? "unknown";

export const APP_GIT_BRANCH: string =
  firstNonEmpty(process.env.APP_GIT_BRANCH, process.env.RAILWAY_GIT_BRANCH) ?? "unknown";

/**
 * A short, human-scannable identifier for this exact running build. Not a
 * standalone source of truth (that's `APP_COMMIT_SHA`/`BUILD_TIME`
 * individually) — this is just those two joined for logs/dashboards.
 */
export const RELEASE_ID: string =
  APP_COMMIT_SHA === "unknown" && BUILD_TIME === "unknown"
    ? "unknown"
    : `${APP_COMMIT_SHA === "unknown" ? "unknown" : APP_COMMIT_SHA.slice(0, 12)}@${BUILD_TIME}`;

export interface ReleaseInfo {
  controlPlaneSha: string;
  branch: string;
  buildTime: string;
  releaseId: string;
  mode: "paper";
  /**
   * Deliberately `null` — see the module docblock. There is currently no
   * deployed mechanism that provisions or version-pins an `aria-engine`
   * artifact into this service's container, so any non-null value here
   * would be fabricated. Flip this once Task 1's P0 gap (see the release
   * manifest) is actually closed.
   */
  engineSha: string | null;
}

export function releaseInfo(): ReleaseInfo {
  return {
    controlPlaneSha: APP_COMMIT_SHA,
    branch: APP_GIT_BRANCH,
    buildTime: BUILD_TIME,
    releaseId: RELEASE_ID,
    mode: "paper",
    engineSha: null,
  };
}
