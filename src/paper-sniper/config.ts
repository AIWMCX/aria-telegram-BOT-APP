/**
 * Pure parsing of the PAPER_SNIPER_* deploy switches (PR E). PAPER ONLY: this
 * module never touches anything that can sign or send a transaction.
 *
 *   PAPER_SNIPER_ENABLED            opt-in. Unset/empty => false. true/1/false/0 only.
 *   PAPER_SNIPER_TELEGRAM_IDS       comma list of numeric Telegram ids that may use the
 *                                   sniper (config seeding, panel, commands, alerts, report).
 *                                   FAIL CLOSED: enabled + unset/blank/malformed => boot refused.
 *   PAPER_SNIPER_REPORT_HOUR_UTC    0-23, default 13.
 *   PAPER_SNIPER_ALERTS_PER_HOUR    1-120, default 12 (per recipient).
 *
 * Error text names the offending variable and, for ids, the offending list
 * entry (an id is not a secret); it never echoes any other value.
 */
export interface PaperSniperFlags {
  enabled: boolean;
  /** Empty when disabled: nobody is allowed. */
  allowedTelegramIds: ReadonlySet<string>;
  reportHourUtc: number;
  alertsPerHour: number;
}

export const DEFAULT_REPORT_HOUR_UTC = 13;
export const DEFAULT_ALERTS_PER_HOUR = 12;

export class PaperSniperConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid PAPER_SNIPER_* configuration: ${problems.join("; ")}`);
    this.name = "PaperSniperConfigError";
  }
}

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

export function parsePaperSniperFlags(env: NodeJS.ProcessEnv): PaperSniperFlags {
  const problems: string[] = [];
  let enabled = false;
  const rawEnabled = env.PAPER_SNIPER_ENABLED;
  if (!blank(rawEnabled)) {
    const v = rawEnabled!.trim().toLowerCase();
    if (v === "true" || v === "1") enabled = true;
    else if (v === "false" || v === "0") enabled = false;
    else problems.push("PAPER_SNIPER_ENABLED must be true/1/false/0");
  }
  if (!enabled && problems.length === 0) {
    return { enabled: false, allowedTelegramIds: new Set(), reportHourUtc: DEFAULT_REPORT_HOUR_UTC, alertsPerHour: DEFAULT_ALERTS_PER_HOUR };
  }

  const allowed = new Set<string>();
  const rawIds = env.PAPER_SNIPER_TELEGRAM_IDS;
  if (blank(rawIds)) {
    problems.push("PAPER_SNIPER_TELEGRAM_IDS is unset or blank while PAPER_SNIPER_ENABLED=true; list the numeric Telegram ids allowed to use the paper sniper (fail closed)");
  } else {
    for (const part of rawIds!.split(",")) {
      const id = part.trim();
      if (!/^[1-9]\d{0,14}$/.test(id)) {
        problems.push(`PAPER_SNIPER_TELEGRAM_IDS must be a comma list of numeric Telegram ids (bad entry ${JSON.stringify(id.slice(0, 20))})`);
        break;
      }
      allowed.add(id);
    }
  }

  let reportHourUtc = DEFAULT_REPORT_HOUR_UTC;
  if (!blank(env.PAPER_SNIPER_REPORT_HOUR_UTC)) {
    const s = env.PAPER_SNIPER_REPORT_HOUR_UTC!.trim();
    if (/^\d{1,2}$/.test(s) && Number(s) <= 23) reportHourUtc = Number(s);
    else problems.push("PAPER_SNIPER_REPORT_HOUR_UTC must be an integer 0-23");
  }
  let alertsPerHour = DEFAULT_ALERTS_PER_HOUR;
  if (!blank(env.PAPER_SNIPER_ALERTS_PER_HOUR)) {
    const s = env.PAPER_SNIPER_ALERTS_PER_HOUR!.trim();
    if (/^\d{1,3}$/.test(s) && Number(s) >= 1 && Number(s) <= 120) alertsPerHour = Number(s);
    else problems.push("PAPER_SNIPER_ALERTS_PER_HOUR must be an integer 1-120");
  }

  if (problems.length > 0) throw new PaperSniperConfigError(problems);
  return { enabled, allowedTelegramIds: allowed, reportHourUtc, alertsPerHour };
}

export function isSniperUserAllowed(flags: PaperSniperFlags, telegramUserId: number | string | undefined): boolean {
  return flags.enabled && telegramUserId !== undefined && flags.allowedTelegramIds.has(String(telegramUserId));
}
