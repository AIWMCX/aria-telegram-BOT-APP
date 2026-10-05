/**
 * Strict allow-list for tenant ids. Real ids are Postgres UUIDs
 * (engine_clients.id), which this also accepts; `..`, separators, NUL,
 * and anything else that could escape tenantsRoot/logsRoot is rejected.
 * Lives in its own module so desired-state.ts and fleet-manager.ts can both
 * use it without importing each other.
 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function assertValidClientId(clientId: string): void {
  if (typeof clientId !== "string" || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("invalid clientId: must match /^[A-Za-z0-9_-]{1,64}$/");
  }
}
