/**
 * LIVE 0.1 §5.4/§19 — persistence for trade intents and trading accounts.
 *
 * The one thing this module exists to get right: **the database is the
 * only duplicate guard that holds.** An application-level "is one already
 * running?" check is deliberately not relied upon anywhere — the Fleet
 * Manager runs multiple processes and Railway can run multiple replicas,
 * so an in-process guard is not a guarantee, it is a coincidence.
 * `createTradeIntent` is therefore an `INSERT ... ON CONFLICT
 * (idempotency_key) DO NOTHING` followed by a re-SELECT: two concurrent
 * callers with the same key both receive the SAME row, and exactly one row
 * exists. No exception surfaces to the caller, because a losing race is
 * not an error — it is the mechanism working.
 *
 * Modeled directly on `journal_entries.idempotency_key`, which this repo
 * already uses for exactly this purpose in the ledger.
 *
 * Money crosses this boundary as `bigint`; `pg` surfaces bigint columns as
 * strings, and every read below converts explicitly. No float ever touches
 * money.
 */
import { pgPool } from "../db-pg.js";
import { audit } from "../audit.js";
import type { TradeIntentDraft, TradeIntentState } from "./trade-intent.js";

function requirePool() {
  if (!pgPool) throw new Error("DATABASE_URL not configured — the LIVE domain is unavailable");
  return pgPool;
}

export interface TradeIntentRow {
  id: string;
  user_id: number;
  account_id: string;
  wallet: string;
  mint: string;
  side: "BUY" | "SELL";
  amount_lamports: string | null;
  amount_token_raw: string | null;
  state: TradeIntentState;
  idempotency_key: string;
  rejection_code: string | null;
  signed_tx_b64: string | null;
  tx_signature: string | null;
  confirmed_at: string | null;
  reconciled_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface CreateTradeIntentResult {
  row: TradeIntentRow;
  /** False when this call lost the idempotency race and is returning the existing row. */
  created: boolean;
}

/**
 * Exactly-once creation. Returns `created: false` — never an error — when
 * the key already exists, so a retried engine proposal is a no-op rather
 * than a second trade.
 */
export async function createTradeIntent(draft: TradeIntentDraft): Promise<CreateTradeIntentResult> {
  const pool = requirePool();
  const { rows } = await pool.query<TradeIntentRow>(
    `INSERT INTO trade_intents (
       user_id, account_id, proposing_client_id, wallet, risk_policy_id, consent_version,
       mint, side, amount_lamports, amount_token_raw,
       expected_price_quote_lamports, expected_price_base_units,
       strategy_reason, market_evidence, market_observation_at, market_observation_slot,
       candidate_id, state, idempotency_key, created_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12,
       $13, $14, to_timestamp($15::double precision / 1000), $16,
       $17, $18, $19, to_timestamp($20::double precision / 1000), to_timestamp($21::double precision / 1000)
     )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      draft.userId, draft.accountId, draft.proposingClientId, draft.wallet, draft.riskPolicyId, draft.consentVersion,
      draft.mint, draft.side,
      draft.amountLamports === null ? null : draft.amountLamports.toString(),
      draft.amountTokenRaw === null ? null : draft.amountTokenRaw.toString(),
      // Explicitly unwrapped from the QuotedLamports wrapper. This is the
      // deliberate act src/live/money.ts requires — a quoted figure only
      // becomes a bare bigint where someone wrote `.lamports`.
      draft.expectedPriceQuoteLamports.lamports.toString(),
      draft.expectedPriceBaseUnits.toString(),
      draft.strategyReason, JSON.stringify(draft.marketEvidence),
      draft.marketObservationTimestamp, String(draft.marketObservationSlot),
      draft.candidateId, draft.state, draft.idempotencyKey,
      draft.createdAt, draft.expiresAt,
    ],
  );

  if (rows.length === 1) {
    audit("engine", "live_intent_created", { type: "trade_intent", id: rows[0]!.id }, {
      accountId: draft.accountId, mint: draft.mint, side: draft.side, idempotencyKey: draft.idempotencyKey,
    });
    return { row: rows[0]!, created: true };
  }

  // Lost the race, or a genuine retry. Either way the existing row is the
  // answer — and it is fetched, not assumed.
  const existing = await getTradeIntentByIdempotencyKey(draft.idempotencyKey);
  if (!existing) throw new Error(`trade_intents: ON CONFLICT fired for ${draft.idempotencyKey} but no row was found`);
  audit("engine", "live_intent_duplicate_suppressed", { type: "trade_intent", id: existing.id }, {
    idempotencyKey: draft.idempotencyKey,
  });
  return { row: existing, created: false };
}

export async function getTradeIntentByIdempotencyKey(key: string): Promise<TradeIntentRow | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<TradeIntentRow>(`SELECT * FROM trade_intents WHERE idempotency_key = $1`, [key]);
  return rows[0];
}

export async function getTradeIntentById(id: string): Promise<TradeIntentRow | undefined> {
  const pool = requirePool();
  const { rows } = await pool.query<TradeIntentRow>(`SELECT * FROM trade_intents WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Firewall F17's input. Returns whether ANY intent for this account is in
 * state UNKNOWN. One unresolved unknown freezes new trading for that
 * account until a human or the recovery loop resolves it — spec §5.2
 * rule 5. The recovery loop itself is NOT built in Milestone 1, so today
 * an UNKNOWN can only be cleared by a human.
 */
export async function accountHasUnknownIntent(accountId: string): Promise<boolean> {
  const pool = requirePool();
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trade_intents WHERE account_id = $1 AND state = 'UNKNOWN'`,
    [accountId],
  );
  return Number(rows[0]!.n) > 0;
}

/**
 * Firewall F8's pending half: intents at or past APPROVED that have not
 * reached a terminal state. Counted as exposure so two near-simultaneous
 * intents cannot both see the same headroom.
 */
export async function pendingExposureLamports(accountId: string): Promise<bigint> {
  const pool = requirePool();
  const { rows } = await pool.query<{ total: string | null }>(
    `SELECT coalesce(sum(amount_lamports), 0)::text AS total
       FROM trade_intents
      WHERE account_id = $1
        AND side = 'BUY'
        AND state IN ('APPROVED','AWAITING_SIGNATURE','SIGNED','SUBMITTED','CONFIRMED','UNKNOWN')`,
    [accountId],
  );
  return BigInt(rows[0]?.total ?? "0");
}
