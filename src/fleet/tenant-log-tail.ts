import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactString, collectSecretValues } from "../redact.js";

/**
 * Admin diagnostics: the last lines of a hosted tenant's (or the discovery
 * process's) log file. The fleet writes each child's stdout/stderr to
 * <logsRoot>/<clientId>.log; nothing else surfaces a crash reason, so a
 * crashing tenant was otherwise undiagnosable from Telegram or Railway logs.
 * Output is redacted (env secret values + known secret shapes) and bounded.
 */
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAIL_BYTES = 64 * 1024;
export const MAX_REPLY_CHARS = 3500;

export function resolveLogName(arg: string | undefined, logsRoot: string): string | null {
  if (arg) {
    if (arg === "discovery") return "discovery.log";
    return CLIENT_ID.test(arg) ? `${arg.toLowerCase()}.log` : null;
  }
  let best: { name: string; mtime: number } | null = null;
  let names: string[] = [];
  try { names = readdirSync(logsRoot); } catch { return null; }
  for (const name of names) {
    if (!/\.log$/.test(name) || name === "discovery.log" || !CLIENT_ID.test(name.slice(0, -4))) continue;
    try {
      const mtime = statSync(path.join(logsRoot, name)).mtimeMs;
      if (!best || mtime > best.mtime) best = { name, mtime };
    } catch { /* vanished */ }
  }
  return best?.name ?? null;
}

export function tailLogFile(file: string, maxLines = 30): string | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const size = statSync(file).size;
    const len = Math.min(size, MAX_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-maxLines).join("\n");
  } finally { closeSync(fd); }
}

export function formatTenantLogReply(name: string, tail: string | null, env: Record<string, unknown> = process.env): string {
  if (tail === null) return `No log file ${name}.`;
  const safe = redactString(tail, collectSecretValues(env));
  const body = safe.length > MAX_REPLY_CHARS ? `…${safe.slice(-MAX_REPLY_CHARS)}` : safe;
  return `Last lines of ${name} (redacted):\n\n${body || "(empty)"}`;
}
