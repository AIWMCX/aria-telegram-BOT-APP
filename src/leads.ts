import { db } from "./db.js";
import { audit } from "./audit.js";

export interface Lead {
  id?: number;
  tg_user_id: number;
  tg_username?: string;
  tg_first_name?: string;
  tg_last_name?: string;
  name: string;
  email: string;
  wallet: string;
  interest?: string;
}

const insertStmt = db.prepare(`
  INSERT INTO leads (tg_user_id, tg_username, tg_first_name, tg_last_name, name, email, wallet, interest)
  VALUES (@tg_user_id, @tg_username, @tg_first_name, @tg_last_name, @name, @email, @wallet, @interest)
  ON CONFLICT(tg_user_id, email) DO UPDATE SET
    name = excluded.name, wallet = excluded.wallet, interest = excluded.interest
  RETURNING id
`);

const findByIdStmt = db.prepare(`SELECT * FROM leads WHERE id = ?`);
const findByTgStmt = db.prepare(`SELECT * FROM leads WHERE tg_user_id = ? ORDER BY id DESC LIMIT 1`);
const countByUserRecentStmt = db.prepare(
  `SELECT COUNT(*) as n FROM leads WHERE tg_user_id = ? AND created_at > datetime('now','-1 hour')`,
);
const countAllStmt = db.prepare(`SELECT COUNT(*) as n FROM leads`);

export function upsertLead(lead: Lead): number {
  const row = insertStmt.get({
    tg_user_id: lead.tg_user_id,
    tg_username: lead.tg_username ?? null,
    tg_first_name: lead.tg_first_name ?? null,
    tg_last_name: lead.tg_last_name ?? null,
    name: lead.name,
    email: lead.email,
    wallet: lead.wallet,
    interest: lead.interest ?? null,
  }) as { id: number };
  audit("system", "lead.created_or_updated", { type: "lead", id: String(row.id) }, { email: lead.email });
  return row.id;
}

export function getLeadById(id: number): Lead | undefined {
  return findByIdStmt.get(id) as Lead | undefined;
}

export function getLatestLeadByTgUser(tgUserId: number): Lead | undefined {
  return findByTgStmt.get(tgUserId) as Lead | undefined;
}

export function recentSubmissionsByUser(tgUserId: number): number {
  return (countByUserRecentStmt.get(tgUserId) as { n: number }).n;
}

export function totalLeads(): number {
  return (countAllStmt.get() as { n: number }).n;
}
