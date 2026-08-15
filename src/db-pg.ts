import { Pool } from "pg";
import { CONFIG } from "./config.js";

/**
 * Postgres pool for the new funded-account domain (users, wallet_accounts,
 * ledger — see docs/ARIA_FUNDS_ARCHITECTURE_V1.md). Separate from the
 * SQLite `db.ts` used by the license product — the two coexist during
 * migration per that document's §4. `null` when DATABASE_URL isn't set
 * (local dev without Postgres, CI) so importers must check before use.
 */
export const pgPool: Pool | null = CONFIG.DATABASE_URL
  ? new Pool({ connectionString: CONFIG.DATABASE_URL })
  : null;
