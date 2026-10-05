/**
 * Pure parsing/validation of the FLEET_* deploy switches. Kept free of
 * config.ts so it is unit-testable and so config.ts can fail boot with a
 * clear message instead of silently defaulting on a malformed value.
 *
 *   FLEET_ENABLED               opt-in kill switch. Unset/empty => false.
 *                               Accepts true/1/false/0 only; anything else is an error.
 *   FLEET_ALLOWED_TELEGRAM_IDS  optional comma list of numeric Telegram ids
 *                               (founder-only first deploy). Unset/empty => no
 *                               allow-list (all approved users when enabled).
 *   FLEET_MIN_FREE_MEMORY_MB    refuse NEW spawns below this much free
 *                               container memory. Unset/empty => 400.
 *   FLEET_MAX_CONCURRENT_TENANTS  positive int. Unset/empty => FleetManager default (3).
 */
export interface FleetFlags {
  enabled: boolean;
  allowedTelegramIds: ReadonlySet<string> | undefined;
  minFreeMemoryMb: number;
  maxConcurrentTenants: number | undefined;
}

export const DEFAULT_MIN_FREE_MEMORY_MB = 400;

export class FleetConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid FLEET_* configuration: ${problems.join("; ")}`);
    this.name = "FleetConfigError";
  }
}

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === "";

export function parseFleetFlags(env: NodeJS.ProcessEnv): FleetFlags {
  const problems: string[] = [];

  let enabled = false;
  const rawEnabled = env.FLEET_ENABLED;
  if (!blank(rawEnabled)) {
    const v = rawEnabled!.trim().toLowerCase();
    if (v === "true" || v === "1") enabled = true;
    else if (v === "false" || v === "0") enabled = false;
    else problems.push(`FLEET_ENABLED must be true/1/false/0 (got ${JSON.stringify(rawEnabled)})`);
  }

  let allowed: Set<string> | undefined;
  const rawAllowed = env.FLEET_ALLOWED_TELEGRAM_IDS;
  if (!blank(rawAllowed)) {
    allowed = new Set();
    for (const part of rawAllowed!.split(",")) {
      const id = part.trim();
      if (!/^[1-9]\d{0,14}$/.test(id)) {
        problems.push(`FLEET_ALLOWED_TELEGRAM_IDS must be a comma list of numeric Telegram ids (bad entry ${JSON.stringify(id)})`);
        break;
      }
      allowed.add(id);
    }
  }

  let minFreeMemoryMb = DEFAULT_MIN_FREE_MEMORY_MB;
  const rawMem = env.FLEET_MIN_FREE_MEMORY_MB;
  if (!blank(rawMem)) {
    if (/^\d{1,6}$/.test(rawMem!.trim())) minFreeMemoryMb = Number(rawMem!.trim());
    else problems.push(`FLEET_MIN_FREE_MEMORY_MB must be a non-negative integer (got ${JSON.stringify(rawMem)})`);
  }

  let maxConcurrentTenants: number | undefined;
  const rawMax = env.FLEET_MAX_CONCURRENT_TENANTS;
  if (!blank(rawMax)) {
    if (/^[1-9]\d{0,3}$/.test(rawMax!.trim())) maxConcurrentTenants = Number(rawMax!.trim());
    else problems.push(`FLEET_MAX_CONCURRENT_TENANTS must be a positive integer (got ${JSON.stringify(rawMax)})`);
  }

  if (problems.length > 0) throw new FleetConfigError(problems);
  return { enabled, allowedTelegramIds: allowed, minFreeMemoryMb, maxConcurrentTenants };
}
