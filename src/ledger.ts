import type { PoolClient } from "pg";
import { pgPool } from "./db-pg.js";

/**
 * The double-entry ledger, per docs/ARIA_FUNDS_ARCHITECTURE_V1.md §3c.
 * postJournalEntry is the ONLY way anything is allowed to move a balance —
 * it enforces the sum-to-zero-per-asset invariant here, in code, rather
 * than trusting every caller to construct balanced postings correctly.
 */

export type LedgerBalanceField = "available" | "reserved" | "pending";
export type LedgerEventType =
  | "deposit_confirmed"
  | "trade_reserved" | "trade_spent" | "trade_released" | "trade_received"
  | "network_fee"
  | "withdrawal_reserved" | "withdrawal_broadcast" | "withdrawal_confirmed" | "withdrawal_failed"
  | "reconciliation_adjustment";
export type LedgerReferenceType = "deposit" | "withdrawal" | "trade" | "reconciliation";
export type LedgerAccountType = "user" | "external_clearing" | "withdrawal_clearing" | "fee_clearing";

export interface PostingInput {
  ledgerAccountId: number;
  asset: string;
  amount: bigint; // signed: +credit / -debit
  balanceField: LedgerBalanceField;
}

export interface JournalEntryInput {
  eventType: LedgerEventType;
  referenceType: LedgerReferenceType;
  referenceId: string;
  idempotencyKey: string;
  postings: PostingInput[];
}

/**
 * Validates that postings sum to zero per asset. Pure function, no DB —
 * exercised directly in unit tests without needing Postgres.
 */
export function validateBalancedPostings(postings: PostingInput[]): void {
  if (postings.length < 2) {
    throw new Error(`journal entry needs >=2 postings, got ${postings.length}`);
  }
  const sumsByAsset = new Map<string, bigint>();
  for (const p of postings) {
    sumsByAsset.set(p.asset, (sumsByAsset.get(p.asset) ?? 0n) + p.amount);
  }
  for (const [asset, sum] of sumsByAsset) {
    if (sum !== 0n) {
      throw new Error(`unbalanced journal entry for asset ${asset}: postings sum to ${sum}, must be 0`);
    }
  }
}

/**
 * Writes one journal_entries row and its ledger_postings, inside the
 * given transaction client (caller controls the transaction boundary —
 * see the self-test below for how a whole scenario gets wrapped and
 * rolled back). Throws before any write if postings don't balance.
 */
export async function postJournalEntry(client: PoolClient, input: JournalEntryInput): Promise<number> {
  validateBalancedPostings(input.postings);

  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO journal_entries (event_type, reference_type, reference_id, idempotency_key)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.eventType, input.referenceType, input.referenceId, input.idempotencyKey],
  );
  const journalEntryId = rows[0]!.id;

  for (const p of input.postings) {
    await client.query(
      `INSERT INTO ledger_postings (journal_entry_id, ledger_account_id, asset, amount, balance_field)
       VALUES ($1, $2, $3, $4, $5)`,
      [journalEntryId, p.ledgerAccountId, p.asset, p.amount.toString(), p.balanceField],
    );
  }

  return journalEntryId;
}

/** Live balance from ledger_postings — the source of truth, not the cached columns on ledger_accounts. */
export async function getBalance(
  client: PoolClient,
  ledgerAccountId: number,
  balanceField: LedgerBalanceField,
): Promise<bigint> {
  const { rows } = await client.query<{ sum: string | null }>(
    `SELECT SUM(amount)::text AS sum FROM ledger_postings WHERE ledger_account_id = $1 AND balance_field = $2`,
    [ledgerAccountId, balanceField],
  );
  return BigInt(rows[0]?.sum ?? "0");
}

export async function getOrCreateLedgerAccount(
  client: PoolClient,
  input: { userId: number | null; accountType: LedgerAccountType; asset: string },
): Promise<number> {
  const existing = await client.query<{ id: number }>(
    input.userId === null
      ? `SELECT id FROM ledger_accounts WHERE user_id IS NULL AND account_type = $1 AND asset = $2`
      : `SELECT id FROM ledger_accounts WHERE user_id = $1 AND asset = $2`,
    input.userId === null ? [input.accountType, input.asset] : [input.userId, input.asset],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO ledger_accounts (user_id, account_type, asset) VALUES ($1, $2, $3) RETURNING id`,
    [input.userId, input.accountType, input.asset],
  );
  return rows[0]!.id;
}

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — ledger domain is unavailable");
  return pgPool;
}
export { requirePool as requireLedgerPool };
