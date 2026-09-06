import { pgPool } from "./db-pg.js";
import { logger } from "./logger.js";

/**
 * First-10 beta funnel telemetry — see migrations/1757100000000_create-funnel-events.js.
 * Fire-and-forget by design: a telemetry write failing must never break
 * the real user action it's recording. Every call site wraps this in
 * its own try/catch (or this function swallows internally — see below)
 * so a funnel-tracking bug can't become a product-breaking bug.
 */
export type FunnelEvent =
  | "invite_created"
  | "invite_redeemed"
  | "miniapp_opened"
  | "pairing_code_created"
  | "pairing_completed"
  | "engine_online"
  | "paper_started"
  | "first_candidate_seen"
  | "first_position_seen"
  | "journal_opened"
  | "returned_session"
  | "support_opened"
  | "live_interest_clicked"
  | "paid_interest_clicked"
  | "feedback_submitted";

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — funnel telemetry unavailable");
  return pgPool;
}

/** Never throws — a telemetry failure must never surface to the caller or affect the real action being tracked. */
export async function trackEvent(event: FunnelEvent, userId?: number, metadata?: Record<string, unknown>): Promise<void> {
  try {
    const pool = requirePool();
    await pool.query(
      `INSERT INTO funnel_events (event, user_id, metadata) VALUES ($1, $2, $3)`,
      [event, userId ?? null, metadata ? JSON.stringify(metadata) : null],
    );
  } catch (err) {
    logger.warn({ err, event }, "funnel event tracking failed — real action unaffected");
  }
}

export interface FunnelCounts {
  event: string;
  count: number;
  distinctUsers: number;
}

/** Simple aggregate for the beta operations view — counts per event, not a general analytics query engine. */
export async function getFunnelCounts(): Promise<FunnelCounts[]> {
  const pool = requirePool();
  const { rows } = await pool.query<{ event: string; count: string; distinct_users: string }>(
    `SELECT event, COUNT(*) as count, COUNT(DISTINCT user_id) as distinct_users
     FROM funnel_events GROUP BY event ORDER BY event`,
  );
  return rows.map((r) => ({ event: r.event, count: Number(r.count), distinctUsers: Number(r.distinct_users) }));
}
