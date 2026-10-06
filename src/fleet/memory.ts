import fs from "node:fs";
import os from "node:os";

/**
 * Available memory for a NEW tenant, in bytes: the container's cgroup limit
 * minus its current usage when a limit is present (cgroup v2, then v1),
 * otherwise os.freemem(). When both are known the smaller wins. Pure and
 * injectable for tests. UNVERIFIED on a real Linux/Railway container.
 */
export function readAvailableMemoryBytes(
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  freemem: () => number = os.freemem,
): number {
  const num = (p: string): number | undefined => {
    try {
      const t = readFile(p).trim();
      if (!/^\d+$/.test(t)) return undefined; // "max" or garbage
      return Number(t);
    } catch {
      return undefined;
    }
  };
  const UNLIMITED = 2 ** 60; // cgroup v1 reports ~2^63 for "no limit"
  let cg: number | undefined;
  const v2max = num("/sys/fs/cgroup/memory.max");
  const v2cur = num("/sys/fs/cgroup/memory.current");
  if (v2max !== undefined && v2cur !== undefined) cg = v2max - v2cur;
  else {
    const v1max = num("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    const v1cur = num("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    if (v1max !== undefined && v1cur !== undefined && v1max < UNLIMITED) cg = v1max - v1cur;
  }
  const host = freemem();
  const raw = cg === undefined ? host : Math.min(cg, host);
  // NaN/negative/non-finite means "unknown": report 0 so the spawn guard refuses.
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
