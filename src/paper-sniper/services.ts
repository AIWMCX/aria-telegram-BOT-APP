import { InlineKeyboard, type Bot } from "grammy";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG, PAPER_SNIPER_FLAGS } from "../config.js";
import { logger } from "../logger.js";
import { AlertService } from "./alerts.js";
import { readSniperSnapshot } from "./data.js";
import { formatDailyReport } from "./format.js";
import { sniperTenantRuntimeDir } from "./runtime-dir.js";
import { DailyReportScheduler } from "./scheduler.js";
import { paperSniperHealth } from "../fleet/discovery-instance.js";

let alertTimer: ReturnType<typeof setInterval> | undefined;
let scheduler: DailyReportScheduler | undefined;

const stateFile = (): string => path.join(path.dirname(path.resolve(CONFIG.FLEET_TENANTS_ROOT)), "paper-sniper-report-state.json");

/** Starts the assisted-snipe alert poller and the daily report. No-op unless the sniper is enabled AND usable. Never throws. */
export function startPaperSniperServices(bot: Bot): void {
  try {
    if (!paperSniperHealth().enabled) { logger.info({ reason: paperSniperHealth().reason }, "paper sniper services are OFF"); return; }
    const flags = PAPER_SNIPER_FLAGS;
    const alerts = new AlertService({
      allowedIds: () => flags.allowedTelegramIds,
      resolveRuntimeDir: (id) => sniperTenantRuntimeDir(id),
      send: async (id, msg) => {
        const kb = msg.url && msg.urlLabel ? new InlineKeyboard().url(msg.urlLabel, msg.url) : undefined;
        await bot.api.sendMessage(Number(id), msg.html, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}), link_preview_options: { is_disabled: true } });
      },
      sendNote: async (id, text) => { await bot.api.sendMessage(Number(id), text); },
      alertsPerHour: flags.alertsPerHour,
      log: logger,
    });
    alertTimer = setInterval(() => { void alerts.tick(); }, 5_000);
    alertTimer.unref?.();

    scheduler = new DailyReportScheduler({
      hourUtc: flags.reportHourUtc,
      loadLastDay: () => { try { return (JSON.parse(readFileSync(stateFile(), "utf8")) as { day?: string }).day; } catch { return undefined; } },
      saveLastDay: (day) => {
        try { mkdirSync(path.dirname(stateFile()), { recursive: true }); const t = `${stateFile()}.tmp`; writeFileSync(t, JSON.stringify({ day }), { mode: 0o600 }); renameSync(t, stateFile()); } catch { /* best effort */ }
      },
      run: async () => {
        for (const id of flags.allowedTelegramIds) {
          try {
            const dir = await sniperTenantRuntimeDir(id);
            if (!dir) continue;
            const now = Date.now();
            const text = formatDailyReport(readSniperSnapshot(dir, { now, sinceMs: now - 86_400_000 }), readSniperSnapshot(dir, { now }));
            await bot.api.sendMessage(Number(id), text);
          } catch (err) { logger.warn({ errName: (err as Error)?.name }, "paper sniper daily report failed for one user"); }
        }
      },
    });
    scheduler.start();
    logger.info({ reportHourUtc: flags.reportHourUtc, alertsPerHour: flags.alertsPerHour }, "paper sniper alert poller and daily report started (PAPER ONLY)");
  } catch (err) {
    logger.error({ errName: (err as Error)?.name }, "paper sniper services failed to start - everything else is unaffected");
  }
}

export function stopPaperSniperServices(): void {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = undefined;
  scheduler?.stop();
}
