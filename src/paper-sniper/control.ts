import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Kill / resume for one tenant's paper sniper. These are the engine's OWN
 * file protocol (aria-engine src/paper/sniper/kill-switch.ts @ 4fadcd3):
 * `<runtimeDir>/KILL` stops new entries within ~1 s (plain kill keeps
 * managing open positions; `{"flatten":true}` also exits them);
 * resume removes KILL and writes the one-shot `<runtimeDir>/RESUME` token
 * that also clears latched halts. The runtimeDir must come from
 * FleetManager.runtimeDirFor (validated clientId), never from user input.
 */
export function writeKillFlag(runtimeDir: string, flatten = false): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(runtimeDir, "KILL"), JSON.stringify({ flatten, at: new Date().toISOString() }), { mode: 0o600 });
}

export function writeResumeFlag(runtimeDir: string): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try { unlinkSync(path.join(runtimeDir, "KILL")); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  writeFileSync(path.join(runtimeDir, "RESUME"), JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
}
