import fs from "node:fs";
import path from "node:path";
import { CLIENT_ID_PATTERN, assertValidClientId } from "./client-id.js";

/**
 * Durable DESIRED STATE for one hosted tenant, kept on the volume (not in a
 * DB migration): `<tenantsRoot>/<clientId>/desired-state.json`.
 *
 * Why this exists: the Fleet Manager's tenant map is memory-only, so a
 * control-plane restart/redeploy used to kill every user's engine silently
 * and /paper_status then claimed "Never started". The file records what the
 * USER asked for ("running" after /paper_start, "stopped" after /paper_stop,
 * or after an approval revoke) — never what the process happens to be doing.
 * Process shutdown deliberately does NOT touch it: that is the whole point,
 * the next boot reads it and brings the tenant back.
 *
 * Write-before-act: callers write it BEFORE spawning/stopping, so a crash
 * between the write and the action is recovered by rehydration instead of
 * leaving a user whose engine is "supposed" to run with no record of it.
 */

export type DesiredState = "running" | "stopped";

export interface DesiredStateRecord {
  version: 1;
  desired: DesiredState;
  updatedAtMs: number;
}

/** Minimal logger shape (pino-compatible). The real one is the redacting logger from src/logger.ts. */
export interface FleetLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const NOOP_LOGGER: FleetLogger = { info() {}, warn() {}, error() {} };

export const DESIRED_STATE_FILE = "desired-state.json";

export function desiredStatePath(tenantsRoot: string, clientId: string): string {
  assertValidClientId(clientId); // before ANY path is built
  return path.join(tenantsRoot, clientId, DESIRED_STATE_FILE);
}

/**
 * Atomic write: temp file (mode 0o600) in the same directory, then rename.
 * A reader therefore sees either the old complete file or the new complete
 * file, never a torn one. Throws on I/O failure — callers on the write-before-
 * act path must treat that as "do not act".
 */
export function writeDesiredState(tenantsRoot: string, clientId: string, desired: DesiredState, nowMs = Date.now()): void {
  const file = desiredStatePath(tenantsRoot, clientId);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: DesiredStateRecord = { version: 1, desired, updatedAtMs: nowMs };
  const tmp = path.join(dir, `${DESIRED_STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

/**
 * Validated read. Missing, unreadable, corrupt, wrong-version or
 * unknown-value files all return `undefined` (== "no usable desired state")
 * and are logged (corrupt ones only) — never thrown.
 */
export function readDesiredState(tenantsRoot: string, clientId: string, log: FleetLogger = NOOP_LOGGER): DesiredStateRecord | undefined {
  const file = desiredStatePath(tenantsRoot, clientId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn({ clientId, code: (err as NodeJS.ErrnoException)?.code }, "desired-state file unreadable — treated as absent");
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DesiredStateRecord> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      (parsed.desired === "running" || parsed.desired === "stopped") &&
      typeof parsed.updatedAtMs === "number" &&
      Number.isFinite(parsed.updatedAtMs)
    ) {
      return { version: 1, desired: parsed.desired, updatedAtMs: parsed.updatedAtMs };
    }
    log.warn({ clientId }, "desired-state file has an unknown shape/version — treated as absent");
  } catch {
    log.warn({ clientId }, "desired-state file is corrupt JSON — treated as absent");
  }
  return undefined;
}

/** Client ids (valid-allow-list directory names only) under tenantsRoot whose validated desired state is "running". Never throws. */
export function listDesiredRunning(tenantsRoot: string, log: FleetLogger = NOOP_LOGGER): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(tenantsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (!CLIENT_ID_PATTERN.test(name)) continue; // ignore anything that is not a valid tenant id
    if (readDesiredState(tenantsRoot, name, log)?.desired === "running") out.push(name);
  }
  return out;
}
