/**
 * Daily report scheduler (PR E). Fires once per UTC day at/after `hourUtc`:00,
 * but only within `graceMs` of that moment, so a restart at 20:00 does not send
 * a "13:00" report seven hours late. The last-sent UTC day is persisted through
 * the injected load/save (a file on the volume in production) so a restart
 * inside the window does not send twice. `tick()` is pure of timers: tests
 * drive it with a fake clock; `start()` wires a real interval.
 */
export interface DailyReportSchedulerDeps {
  hourUtc: number;
  now?: () => number;
  loadLastDay: () => string | undefined;
  saveLastDay: (day: string) => void;
  run: () => Promise<void>;
  graceMs?: number;
}

export const DEFAULT_REPORT_GRACE_MS = 2 * 3_600_000;

export class DailyReportScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** In-memory fallback: a failing persisted load/save must never turn into a send on every tick. */
  private memDay: string | undefined;
  private readonly now: () => number;

  constructor(private readonly d: DailyReportSchedulerDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Returns true when a report run was started by this tick. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    const n = this.now();
    const day = new Date(n).toISOString().slice(0, 10);
    const dueAt = Date.parse(`${day}T${String(this.d.hourUtc).padStart(2, "0")}:00:00.000Z`);
    if (n < dueAt || n - dueAt > (this.d.graceMs ?? DEFAULT_REPORT_GRACE_MS)) return false;
    if (this.memDay === day) return false;
    let persisted: string | undefined;
    try { persisted = this.d.loadLastDay(); } catch { persisted = undefined; }
    if (persisted === day) { this.memDay = day; return false; }
    this.running = true;
    try {
      // Mark BEFORE running: a crash mid-send must not turn into a second full send on restart.
      this.memDay = day;
      try { this.d.saveLastDay(day); } catch { /* memDay still prevents a repeat in this process */ }
      await this.d.run();
      return true;
    } finally { this.running = false; }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
