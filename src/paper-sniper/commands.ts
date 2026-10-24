import { writeKillFlag, writeResumeFlag } from "./control.js";
import { isSniperUserAllowed, type PaperSniperFlags } from "./config.js";
import { readKillFlag, readSniperSnapshot, type SniperSnapshot } from "./data.js";
import { formatOnDemandReport } from "./format.js";

/**
 * Telegram command logic for the paper sniper (/paper_report, /kill,
 * /resume). grammy-free: dependencies are injected so tests never need a bot.
 * Allowed users only (PAPER_SNIPER_TELEGRAM_IDS); everyone else, and every
 * caller while the feature is off, gets the same neutral refusal.
 */
export interface SniperCommandDeps {
  flags: PaperSniperFlags;
  resolveRuntimeDir: (telegramUserId: number) => Promise<string | undefined>;
  readSnapshot?: (runtimeDir: string) => SniperSnapshot;
}

export const NOT_AVAILABLE = "This command is not available.";
export const NO_TENANT = "No hosted PAPER engine for your account yet. Use /paper_start first.";

export async function handleSniperCommand(
  kind: "paper_report" | "kill" | "resume",
  deps: SniperCommandDeps,
  telegramUserId: number | undefined,
  args = "",
): Promise<string> {
  if (!isSniperUserAllowed(deps.flags, telegramUserId)) return NOT_AVAILABLE;
  const dir = await deps.resolveRuntimeDir(telegramUserId!);
  if (!dir) return NO_TENANT;
  if (kind === "paper_report") {
    return formatOnDemandReport((deps.readSnapshot ?? ((d: string) => readSniperSnapshot(d)))(dir));
  }
  if (kind === "kill") {
    const flatten = args.trim().toLowerCase() === "flatten";
    writeKillFlag(dir, flatten);
    return flatten
      ? "KILL flag written (flatten). The paper sniper takes no new entries and closes its open PAPER positions. Use /resume to clear it."
      : "KILL flag written. The paper sniper takes no new entries (open PAPER positions keep being managed). Use /resume to clear it, or /kill flatten to also close them.";
  }
  writeResumeFlag(dir);
  const k = readKillFlag(dir);
  return k.killed ? "Resume requested but the KILL flag is still present." : "KILL flag cleared and a RESUME token written. New paper entries resume (latched halts are cleared too).";
}
