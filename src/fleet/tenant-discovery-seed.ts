import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildTenantEnv } from "./tenant-process.js";

/**
 * Per-tenant discovery source seeding (PR B2). A tenant gets the shared feed
 * through its OWN runtime config (`discovery: { source: "file-tail", path }`
 * - a path, never an endpoint or key), and only while DISCOVERY is enabled.
 * Turning discovery off flips a tenant that points at OUR feed back to the
 * engine's polling default; a tenant config that points anywhere else is
 * never touched.
 *
 * The edit is made by the engine's own `aria config set` (so the engine's
 * validation is the single schema authority) run with the TENANT env
 * (buildTenantEnv): it never sees a stream variable.
 */
export type ConfigSetRunner = (args: string[], runtimeDir: string) => Promise<void>;

export interface TenantDiscoveryState { source: string | undefined; path: string | undefined }

export function readTenantDiscoveryState(runtimeDir: string): TenantDiscoveryState {
  try {
    const p = path.join(runtimeDir, "config.json");
    if (!existsSync(p)) return { source: undefined, path: undefined };
    const raw = JSON.parse(readFileSync(p, "utf8")) as { discovery?: { source?: unknown; path?: unknown } };
    return {
      source: typeof raw.discovery?.source === "string" ? raw.discovery.source : undefined,
      path: typeof raw.discovery?.path === "string" ? raw.discovery.path : undefined,
    };
  } catch {
    return { source: undefined, path: undefined };
  }
}

/** Returns what it did. Throws only if the runner fails (the caller treats that as non-fatal). */
export async function reconcileTenantDiscovery(o: {
  runtimeDir: string;
  feedPath: string;
  enabled: boolean;
  run: ConfigSetRunner;
}): Promise<"enabled" | "disabled" | "unchanged"> {
  const cur = readTenantDiscoveryState(o.runtimeDir);
  const onOurFeed = cur.source === "file-tail" && cur.path === o.feedPath;
  if (o.enabled && !onOurFeed) {
    await o.run(["config", "set", "discovery.fileTail", o.feedPath], o.runtimeDir);
    return "enabled";
  }
  if (!o.enabled && onOurFeed) {
    await o.run(["config", "set", "discovery.source", "polling"], o.runtimeDir);
    return "disabled";
  }
  return "unchanged";
}

/** Real runner: `node --import tsx src/cli.ts <args>` in the engine tree with the tenant env. */
export function engineConfigSetRunner(enginePath: string, parentEnv: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000): ConfigSetRunner {
  return (args, runtimeDir) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
        cwd: enginePath,
        env: buildTenantEnv(parentEnv, undefined, runtimeDir),
        stdio: ["ignore", "ignore", "ignore"],
      });
      const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("engine config set timed out")); }, timeoutMs);
      child.once("error", (e) => { clearTimeout(t); reject(e); });
      child.once("exit", (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`engine config set exited ${code}`)); });
    });
}
