/**
 * LIVE Vertical Slice 0.1 — Milestone 1 schema.
 *
 * This is docs/proposed-002_trading_accounts.sql (branch
 * plan/live-vertical-slice-0.1) promoted to a real migration, per that
 * file's own instruction that it be renamed verbatim on approval. The
 * only substantive additions are the two founder-gating columns at the
 * bottom of trading_accounts and the ownership-proof challenge column —
 * both called out inline below.
 *
 * Companion to docs/SPEC-LIVE-VERTICAL-SLICE-0.1.md. Read that spec's §1,
 * §2, §4, §5 and §19 before reviewing this schema — every table and every
 * constraint below exists to make one specific invariant from that spec a
 * DATABASE guarantee rather than an application convention.
 *
 * Conventions taken from the existing migrations/ directory and preserved:
 *   - pgm.createType() for every enum, dropped in reverse order in down().
 *   - onDelete: "RESTRICT" on every users FK — a user is never silently
 *     orphaned from money-bearing rows (1755238500000_create-wallet-accounts.js).
 *   - Partial unique indexes to enforce "at most one active X" rather than
 *     relying on application code (wallet_accounts_one_active_per_user).
 *   - A UNIQUE idempotency_key column as the real exact-once mechanism
 *     (1755240000000_create-ledger.js, journal_entries.idempotency_key).
 *   - bigint for all lamport amounts. Never numeric, never float.
 *
 * SECURITY NOTE, stated so it is checkable rather than assumed: there is no
 * column anywhere below capable of holding a private key, seed phrase,
 * mnemonic or keypair. The only signature-bearing columns hold (a) a signature
 * over a server-issued nonce, and (b) a fully-formed signed transaction, which
 * is a bearer instrument for exactly one transaction and is NULLed at every
 * terminal state (see the comment on trade_intents.signed_tx_b64).
 * test/live-schema-contract.ts asserts this mechanically against the live schema.
 */

exports.up = (pgm) => {
  // ── wallet_accounts: additive amendment ────────────────────────────────
  // The existing table's docblock says "wallet_accounts.status = 'active'
  // gates signing". That sentence is true for the two DELEGATED authority
  // models it was written for, and FALSE for a self-custody row — ARIA cannot
  // gate signing for a wallet whose key it does not hold and will never hold.
  // The new enum member is added here rather than a parallel table so the
  // existing one-active-wallet-per-user partial unique index and the deposits
  // FK continue to apply unchanged to self-custody wallets too.
  pgm.addTypeValue("authority_model", "self_custody", { ifNotExists: true });

  // ── wallet_ownership_proofs ────────────────────────────────────────────
  // Evidence for the CONNECTED gate (spec §2.1 E1). A client asserting "I
  // connected" is not evidence; a signature over a nonce ARIA issued, which
  // ARIA re-verifies server-side with node:crypto, is.
  pgm.createTable("wallet_ownership_proofs", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    wallet_account_id: { type: "integer", notNull: true, references: "wallet_accounts", onDelete: "RESTRICT" },
    solana_pubkey: { type: "text", notNull: true },
    // Single-use, 300s TTL, bound to this row. Issued by the server, never
    // chosen by the client — a client-chosen nonce is not a challenge.
    nonce: { type: "text", notNull: true, unique: true },
    // ADDED vs the proposal. The exact challenge string the server told the
    // user to sign, persisted at issue time. Without it, verification would
    // have to RE-DERIVE the message at verify time, and any drift in the
    // derivation (a renamed field, a reordered segment) silently turns a
    // real proof into a failure — or worse, makes two different messages
    // both "valid" for one nonce. The bytes that were challenged are stored,
    // not reconstructed.
    challenge_message: { type: "text", notNull: true },
    // base64 Ed25519 signature over the challenge. Public material: it cannot
    // be replayed (the nonce is single-use) and the key cannot be derived
    // from it.
    signature_b64: { type: "text" },
    issued_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
    verified_at: { type: "timestamptz" },
  });
  pgm.createIndex("wallet_ownership_proofs", ["user_id", "verified_at"]);
  // A verified proof must carry the signature it was verified against.
  pgm.addConstraint("wallet_ownership_proofs", "wallet_ownership_proofs_verified_has_signature", {
    check: "verified_at IS NULL OR signature_b64 IS NOT NULL",
  });

  // ── live_consents ──────────────────────────────────────────────────────
  // Spec §3. text_sha256 is the hash of the exact bytes served to the user,
  // computed server-side at serve time and re-checked at accept time — so
  // "which words did they agree to" is answerable by hash, not by trusting
  // that the disclosure file was never edited in place.
  pgm.createTable("live_consents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    consent_version: { type: "text", notNull: true },
    text_sha256: { type: "text", notNull: true },
    accepted_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    initdata_telegram_user_id: { type: "bigint", notNull: true },
    user_agent: { type: "text" },
  });
  pgm.createIndex("live_consents", ["user_id", "consent_version"]);

  // ── live_risk_policies ─────────────────────────────────────────────────
  // Spec §4. IMMUTABLE once referenced by a trade_intents row — "editing"
  // limits inserts a new row and repoints trading_accounts.risk_policy_id, so
  // the exact limits any historical intent was judged against stay recoverable
  // forever. Enforced by application code plus the superseded_at convention;
  // a DB-level immutability trigger is deliberately NOT added here (it would
  // be the only trigger in this schema, and the referencing FK from
  // trade_intents already makes an edit detectable in audit).
  pgm.createTable("live_risk_policies", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    max_trade_lamports: { type: "bigint", notNull: true },
    max_open_positions: { type: "integer", notNull: true },
    max_total_exposure_lamports: { type: "bigint", notNull: true },
    max_daily_realized_loss_lamports: { type: "bigint", notNull: true },
    max_slippage_bps: { type: "integer", notNull: true },
    max_execution_cost_lamports: { type: "bigint", notNull: true },
    max_execution_cost_bps_of_trade: { type: "integer", notNull: true },
    mint_cooldown_seconds: { type: "integer", notNull: true },
    // New vs PaperConfig. PAPER cannot run out of money; a LIVE account can be
    // drained by many small trades across DIFFERENT mints, each individually
    // inside every per-mint limit. This is the control that closes that.
    global_cooldown_seconds: { type: "integer", notNull: true },
    // Closes the minimum-reserve gap paper-risk.ts explicitly DEFERRED
    // ("PAPER's capital model has no canonical wallet-balance concept to
    // derive it from"). LIVE has one, so LIVE can close it. A position you
    // cannot afford the fees to exit is not a position.
    min_reserve_lamports: { type: "bigint", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    superseded_at: { type: "timestamptz" },
  });
  pgm.createIndex("live_risk_policies", "user_id");
  // Sanity bounds the application also checks (validateRiskPolicy) — duplicated
  // here on purpose: an application bug must not be able to persist a policy
  // that would let the firewall approve an unbounded trade.
  pgm.addConstraint("live_risk_policies", "live_risk_policies_sane_bounds", {
    check: `max_trade_lamports > 0
            AND max_total_exposure_lamports >= max_trade_lamports
            AND max_daily_realized_loss_lamports > 0
            AND max_open_positions BETWEEN 1 AND 10
            AND max_slippage_bps BETWEEN 1 AND 5000
            AND max_execution_cost_lamports > 0
            AND max_execution_cost_bps_of_trade BETWEEN 1 AND 5000
            AND mint_cooldown_seconds >= 0
            AND global_cooldown_seconds >= 0
            AND min_reserve_lamports >= 0`,
  });

  // ── trading_accounts ───────────────────────────────────────────────────
  // Spec §1/§2. Owns the LIVE trading RELATIONSHIP (state machine, policy,
  // consent, arming, balance observation). wallet_accounts continues to own
  // wallet IDENTITY. The split is deliberate — see spec §2.5.
  //
  // STOPPED is TERMINAL. There is no transition out of it in the application
  // state machine, and recovering from an emergency stop means creating a new
  // row that re-walks every evidence gate from UNCONFIGURED.
  pgm.createType("trading_account_state", [
    "UNCONFIGURED", "CONNECTED", "FUNDED", "READY", "ARMED", "PAUSED", "STOPPED",
  ]);

  pgm.createTable("trading_accounts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    wallet_account_id: { type: "integer", notNull: true, references: "wallet_accounts", onDelete: "RESTRICT" },

    state: { type: "trading_account_state", notNull: true, default: "UNCONFIGURED" },
    // Independent of `state`: the per-account half of the two-key kill switch
    // (the other half is the global LIVE_ENABLED config flag). Firewall F3
    // requires BOTH. Defaults false — spec/REAL2_EXECUTION_STATE.md: no
    // ordinary beta user is ever moved into LIVE automatically.
    live_enabled: { type: "boolean", notNull: true, default: false },

    // ADDED vs the proposal — Milestone 1's founder-only requirement, made a
    // DATABASE fact rather than only a config lookup. The firewall requires
    // BOTH this column AND membership of the LIVE_FOUNDER_TELEGRAM_IDS
    // config allowlist (src/config.ts). Two independent sources must agree
    // before any account is eligible at all, so neither a stray UPDATE nor a
    // stray env var can unilaterally admit a non-founder.
    founder_allowlisted: { type: "boolean", notNull: true, default: false },
    // The Telegram user id this account is gated to. Checked against the
    // config allowlist by the firewall. Nullable only so a row can exist
    // before gating is decided; an account with a null value can never be
    // approved by the firewall (UNCERTAIN = REJECT).
    founder_telegram_user_id: { type: "bigint" },

    risk_policy_id: { type: "uuid", references: "live_risk_policies", onDelete: "RESTRICT" },
    consent_version: { type: "text" },
    consent_accepted_at: { type: "timestamptz" },

    // Observed by ARIA's OWN RPC at `confirmed`, never reported by a client.
    // The FUNDED gate and firewall F6 both treat an observation older than
    // ACCOUNT_BALANCE_FRESHNESS_SECONDS as UNCERTAIN, and UNCERTAIN = REJECT.
    last_observed_balance_lamports: { type: "bigint" },
    last_balance_observed_at: { type: "timestamptz" },
    min_funded_lamports: { type: "bigint", notNull: true, default: 10000000 }, // 0.01 SOL

    // Arming is TIME-BOXED (spec §2.3). A standing, never-expiring
    // authorization to push sign-prompts at a user is not an authorization we
    // are willing to hold. Expiry is evaluated lazily on read and by the
    // firewall — no cron, matching engine_commands.expires_at's existing
    // lazy-expiry discipline.
    armed_at: { type: "timestamptz" },
    armed_until: { type: "timestamptz" },
    arm_window_seconds: { type: "integer", notNull: true, default: 3600 },

    paused_reason: { type: "text" },
    stopped_reason: { type: "text" },
    stopped_at: { type: "timestamptz" },

    // Tracked separately from protocol fees for the same stated reason
    // PaperAccountSnapshot.totalPaperExecutionCostLamports is: each
    // economically distinct cost component stays independently auditable
    // rather than merged into one bucket.
    total_execution_cost_lamports: { type: "bigint", notNull: true, default: 0 },
    realized_pnl_lamports: { type: "bigint", notNull: true, default: 0 },

    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("trading_accounts", "user_id");
  // One non-terminal trading account per user in 0.1 (max_open_positions is 1
  // and the whole slice is single-wallet). A STOPPED row is excluded so that
  // creating a fresh account after an emergency stop is possible — which is
  // the ONLY supported recovery from STOPPED.
  pgm.createIndex("trading_accounts", "user_id", {
    name: "trading_accounts_one_live_per_user",
    unique: true,
    where: "state <> 'STOPPED'",
  });
  // An ARMED account without an armed_until is a standing authorization with
  // no expiry — structurally forbidden rather than left to application care.
  pgm.addConstraint("trading_accounts", "trading_accounts_armed_requires_window", {
    check: "state <> 'ARMED' OR armed_until IS NOT NULL",
  });
  pgm.addConstraint("trading_accounts", "trading_accounts_arm_window_bounded", {
    check: "arm_window_seconds BETWEEN 60 AND 86400",
  });
  // ADDED vs the proposal: an allowlisted account must name the human it is
  // allowlisted FOR. "Allowlisted, but we don't know who" is exactly the
  // ambiguity the founder gate exists to forbid.
  pgm.addConstraint("trading_accounts", "trading_accounts_allowlisted_names_founder", {
    check: "founder_allowlisted = false OR founder_telegram_user_id IS NOT NULL",
  });

  // ── trade_intents ──────────────────────────────────────────────────────
  // Spec §5. The mandatory boundary between strategy and money.
  //
  // UNKNOWN is a FIRST-CLASS state and is never collapsed into FAILED. There
  // must be no application code path that writes FAILED because a timeout
  // elapsed — FAILED requires a pre-flight rejection, a RETRIEVED err != null,
  // or a proof of non-inclusion (blockhash expired + safety margin).
  pgm.createType("trade_intent_state", [
    "CREATED", "REJECTED", "APPROVED", "AWAITING_SIGNATURE", "SIGNED",
    "SUBMITTED", "CONFIRMED", "RECONCILED", "FAILED", "UNKNOWN", "EXPIRED",
  ]);
  pgm.createType("trade_intent_side", ["BUY", "SELL"]);

  pgm.createTable("trade_intents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    account_id: { type: "uuid", notNull: true, references: "trading_accounts", onDelete: "RESTRICT" },
    // The client_id whose Ed25519 signature carried the proposal. Recorded so
    // attribution is to the SIGNING client, never to
    // getLatestActiveClientForUser() — which returns whichever row was most
    // recently active and is therefore the wrong answer for a user holding
    // both a local and a hosted row (hosted-engine LEDGER, Task 5 finding #2).
    proposing_client_id: { type: "uuid", references: "engine_clients", onDelete: "SET NULL" },

    // Copied at creation, never joined at read time — an intent is forever
    // associated with the wallet, policy and disclosure version in force when
    // it was created, even after any of them change.
    wallet: { type: "text", notNull: true },
    risk_policy_id: { type: "uuid", notNull: true, references: "live_risk_policies", onDelete: "RESTRICT" },
    consent_version: { type: "text", notNull: true },

    mint: { type: "text", notNull: true },
    side: { type: "trade_intent_side", notNull: true },
    amount_lamports: { type: "bigint" },      // BUY: SOL in.  SELL: null
    amount_token_raw: { type: "bigint" },     // SELL: exact base units out. BUY: null
    // PaperPrice's two-integer shape, reused exactly. No float ever touches
    // money in this schema. These are QUOTED (expected) values — the column
    // names say so, and src/live/money.ts makes quoted-vs-realized a TYPE
    // distinction so a future author cannot assign one where the other belongs.
    expected_price_quote_lamports: { type: "bigint", notNull: true },
    expected_price_base_units: { type: "bigint", notNull: true },
    min_output_raw: { type: "bigint" },
    slippage_bps: { type: "integer" },

    strategy_reason: { type: "text", notNull: true },
    market_evidence: { type: "jsonb", notNull: true },
    // Staleness is measured from OBSERVATION, not from proposal time — exactly
    // as evaluatePaperRisk() step 1 does. A proposal that sat in a sync queue
    // for 30s must not look fresh.
    market_observation_at: { type: "timestamptz", notNull: true },
    market_observation_slot: { type: "bigint", notNull: true },
    // Part of the idempotency key; persisted so the key is re-derivable from
    // the row alone during an audit.
    candidate_id: { type: "text", notNull: true },

    state: { type: "trade_intent_state", notNull: true, default: "CREATED" },
    rejection_code: { type: "text" },
    firewall_evidence: { type: "jsonb" },

    // THE exact-once mechanism. sha256 over
    //   accountId | mint | side | marketObservationSlot | candidateId
    // and DELIBERATELY NOT over any timestamp — including createdAt would make
    // every retry unique and silently defeat the whole mechanism. Modeled
    // directly on journal_entries.idempotency_key, which this repo already
    // uses for exactly this purpose in the ledger.
    idempotency_key: { type: "text", notNull: true, unique: true },

    route_provider: { type: "text" },
    route_quote: { type: "jsonb" },
    unsigned_tx_b64: { type: "text" },
    // sha256 of the unsigned transaction's serialized MESSAGE, computed at
    // APPROVED. Re-derived from the signed transaction at pass-2 firewall and
    // compared (check F18). This is what makes "no hidden mutation after
    // approval" mechanically verifiable in BOTH directions — the Mini App
    // cannot substitute bytes after the preview, and neither can ARIA.
    tx_message_hash_hex: { type: "text" },
    recent_blockhash: { type: "text" },
    // Persisted, not a runtime variable: after a crash this is the ONLY way
    // UNKNOWN recovery can reason about expiry at all, and it is unrecoverable
    // from the signature alone.
    last_valid_block_height: { type: "bigint" },
    // Committed BEFORE sendRawTransaction is ever called (write-before-commit,
    // per the hosted-engine Task 4 postmortem). The signature is derived from
    // THESE BYTES on restart, never from the RPC's submit response — the
    // response is precisely the value lost in the crash window we must
    // survive. NULLed at every terminal state so a stale signed transaction
    // can never be found and resubmitted by any future code path.
    signed_tx_b64: { type: "text" },
    tx_signature: { type: "text" },

    // Captured at SIGNED. Corroborating evidence ONLY for UNKNOWN recovery —
    // never sufficient to declare CONFIRMED, because the user controls this
    // wallet and may have traded the same mint manually during the window.
    pre_submit_sol_lamports: { type: "bigint" },
    pre_submit_token_raw: { type: "bigint" },

    recovery_attempts: { type: "integer", notNull: true, default: 0 },
    recovery_next_attempt_at: { type: "timestamptz" },

    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
    submitted_at: { type: "timestamptz" },
    confirmed_at: { type: "timestamptz" },
    reconciled_at: { type: "timestamptz" },
  });
  pgm.createIndex("trade_intents", ["account_id", "state"]);
  pgm.createIndex("trade_intents", "tx_signature");
  // Non-terminal intents, for the boot-time recovery sweep and for firewall
  // checks F8 (pending exposure) and F17 (no UNKNOWN outstanding).
  pgm.createIndex("trade_intents", "state", {
    name: "trade_intents_in_flight",
    where: "state NOT IN ('REJECTED','FAILED','EXPIRED','RECONCILED')",
  });
  // At most ONE non-terminal intent per (account, mint, side). This is a real
  // concurrency guarantee, not an advisory check: two near-simultaneous
  // proposals for the same mint cannot both reserve the same headroom.
  pgm.createIndex("trade_intents", ["account_id", "mint", "side"], {
    name: "trade_intents_one_in_flight_per_account_mint_side",
    unique: true,
    where: "state NOT IN ('REJECTED','FAILED','EXPIRED','RECONCILED')",
  });
  // A terminal intent must not be holding signed bytes. Enforced here because
  // "we remembered to null it" is not a guarantee.
  pgm.addConstraint("trade_intents", "trade_intents_terminal_has_no_signed_bytes", {
    check: `state NOT IN ('REJECTED','FAILED','EXPIRED','RECONCILED')
            OR signed_tx_b64 IS NULL`,
  });
  // A submitted-or-later intent must have a signature. Catches a state write
  // that ran ahead of the fact it claims to represent.
  pgm.addConstraint("trade_intents", "trade_intents_submitted_has_signature", {
    check: `state NOT IN ('SUBMITTED','CONFIRMED','RECONCILED')
            OR tx_signature IS NOT NULL`,
  });
  // ADDED vs the proposal, and the schema half of "SUBMITTED is never
  // CONFIRMED": confirmed_at may only be set for a state that genuinely
  // represents a retrieved, successful confirmation. A row cannot claim a
  // confirmation timestamp while merely SUBMITTED, so no future reader can
  // mistake "we sent it" for "it landed".
  pgm.addConstraint("trade_intents", "trade_intents_confirmed_at_requires_confirmed_state", {
    check: `confirmed_at IS NULL OR state IN ('CONFIRMED','RECONCILED')`,
  });
  pgm.addConstraint("trade_intents", "trade_intents_reconciled_at_requires_reconciled_state", {
    check: `reconciled_at IS NULL OR state = 'RECONCILED'`,
  });
  pgm.addConstraint("trade_intents", "trade_intents_rejected_has_code", {
    check: `state <> 'REJECTED' OR rejection_code IS NOT NULL`,
  });
  pgm.addConstraint("trade_intents", "trade_intents_side_amount_shape", {
    check: `(side = 'BUY'  AND amount_lamports IS NOT NULL AND amount_token_raw IS NULL)
            OR (side = 'SELL' AND amount_token_raw IS NOT NULL AND amount_lamports IS NULL)`,
  });

  // ── live_positions ─────────────────────────────────────────────────────
  // Spec §13/§17. Created ONLY by the reconciler, ONLY from a parsed
  // getTransaction response for a landed transaction, and ONLY in the same
  // Postgres transaction that moves the intent to RECONCILED. A position must
  // never exist for a merely SUBMITTED or CONFIRMED intent.
  //
  // NOTE FOR THE NEXT MILESTONE: the reconciler that writes this table is NOT
  // built in Milestone 1. The table is created here anyway, with the
  // proposal's constraints intact, because the trade_intents FK direction and
  // the one-open-position-per-mint index are part of the same schema
  // guarantee set — splitting them across migrations would leave the
  // guarantees half-stated in the DB for an unknown period.
  //
  // Deliberately NOT an extension of aria-engine's OpenPaperPosition: that
  // type's own docblock forbids any field representing a real transaction,
  // signature or fill, and contracts.test.ts enforces it.
  pgm.createType("live_position_status", [
    "OPEN", "EXITING", "CLOSED", "PARTIALLY_EXITED_NEEDS_ATTENTION",
  ]);

  pgm.createTable("live_positions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "integer", notNull: true, references: "users", onDelete: "RESTRICT" },
    account_id: { type: "uuid", notNull: true, references: "trading_accounts", onDelete: "RESTRICT" },
    mint: { type: "text", notNull: true },
    symbol: { type: "text" }, // null rather than a guess — never invent a symbol

    entry_intent_id: { type: "uuid", notNull: true, unique: true, references: "trade_intents", onDelete: "RESTRICT" },
    entry_tx_signature: { type: "text", notNull: true },
    entry_slot: { type: "bigint", notNull: true },
    exit_intent_id: { type: "uuid", unique: true, references: "trade_intents", onDelete: "RESTRICT" },
    exit_tx_signature: { type: "text" },

    quantity_raw: { type: "bigint", notNull: true },
    decimals: { type: "integer", notNull: true },

    // = -solDelta from the confirmed transaction. meta.fee and the priority
    // fee are ALREADY INCLUDED in solDelta (both debit this same account) and
    // are recorded below as a BREAKDOWN — they must never be added to this
    // number again. Double-counting them overstates cost and understates PnL
    // on every single trade; spec test T32 and blocker P0-FEE-1 exist for
    // exactly this.
    actual_entry_cost_lamports: { type: "bigint", notNull: true },
    entry_network_fee_lamports: { type: "bigint", notNull: true },
    entry_priority_fee_lamports: { type: "bigint", notNull: true },
    effective_entry_price_quote_lamports: { type: "bigint", notNull: true },
    effective_entry_price_base_units: { type: "bigint", notNull: true },

    actual_exit_proceeds_lamports: { type: "bigint" },
    exit_network_fee_lamports: { type: "bigint" },
    exit_priority_fee_lamports: { type: "bigint" },
    // REALIZED_PNL = ACTUAL_EXIT_PROCEEDS - ACTUAL_ENTRY_COST
    //                - ALL_RECONCILED_EXECUTION_COSTS
    // Every term derived exclusively from landed-transaction data. A quote, a
    // preview number, an expectedPrice or a mark may never appear here.
    realized_pnl_lamports: { type: "bigint" },

    status: { type: "live_position_status", notNull: true, default: "OPEN" },
    opened_at: { type: "timestamptz", notNull: true },
    closed_at: { type: "timestamptz" },
  });
  pgm.createIndex("live_positions", ["account_id", "status"]);
  pgm.createIndex("live_positions", ["user_id", "opened_at"]);
  // One open position per (account, mint) — the LIVE analogue of PAPER's
  // duplicate-candidate guard, enforced by the database rather than by the
  // engine's in-memory consumedCandidateIds set (which does not survive a
  // process restart and does not span replicas).
  pgm.createIndex("live_positions", ["account_id", "mint"], {
    name: "live_positions_one_open_per_account_mint",
    unique: true,
    where: "status IN ('OPEN','EXITING')",
  });
  pgm.addConstraint("live_positions", "live_positions_closed_has_exit", {
    check: `status <> 'CLOSED'
            OR (exit_intent_id IS NOT NULL
                AND exit_tx_signature IS NOT NULL
                AND actual_exit_proceeds_lamports IS NOT NULL
                AND realized_pnl_lamports IS NOT NULL)`,
  });
  pgm.addConstraint("live_positions", "live_positions_quantity_positive", {
    check: "quantity_raw > 0 AND actual_entry_cost_lamports > 0",
  });
};

exports.down = (pgm) => {
  // Reverse creation order. Note: pgm.addTypeValue on authority_model is NOT
  // reversed — Postgres cannot drop an enum value, and attempting to rebuild
  // the type would require rewriting wallet_accounts. Leaving the unused
  // 'self_custody' member in place on a down-migration is harmless and is the
  // honest, documented limitation rather than a silently failing down().
  pgm.dropTable("live_positions");
  pgm.dropType("live_position_status");
  pgm.dropTable("trade_intents");
  pgm.dropType("trade_intent_side");
  pgm.dropType("trade_intent_state");
  pgm.dropTable("trading_accounts");
  pgm.dropType("trading_account_state");
  pgm.dropTable("live_risk_policies");
  pgm.dropTable("live_consents");
  pgm.dropTable("wallet_ownership_proofs");
};
