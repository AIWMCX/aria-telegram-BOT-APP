import { pgPool } from "./db-pg.js";

/**
 * First-10 beta feedback capture — see migrations/1757200000000_create-feedback.js.
 * Deliberately no status/thread/reply model: the operator reads
 * /feedback in Telegram and follows up directly with the person. Add
 * workflow state only if volume ever makes that necessary.
 */
export interface FeedbackRow {
  id: string;
  user_id: number | null;
  message: string;
  submitted_at: string;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — feedback capture unavailable");
  return pgPool;
}

export async function submitFeedback(userId: number | undefined, message: string): Promise<void> {
  const pool = requirePool();
  await pool.query(`INSERT INTO feedback (user_id, message) VALUES ($1, $2)`, [userId ?? null, message]);
}

export async function listRecentFeedback(limit = 20): Promise<FeedbackRow[]> {
  const pool = requirePool();
  const { rows } = await pool.query<FeedbackRow>(
    `SELECT * FROM feedback ORDER BY submitted_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
