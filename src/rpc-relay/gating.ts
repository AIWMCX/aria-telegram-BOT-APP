/**
 * Whether a tenant's rpc.url should be pointed at the relay (PR F1), as a pure decision so it can be tested without the
 * config/DB module graph. `sniperResult` is the paper-sniper preparer's outcome for this spawn.
 *  - "leave": the sniper lookup was transient/failed ("skipped"), so neither seed nor revert rpc.url this time;
 *  - true: seed (relay usable AND this tenant is currently a seeded sniper tenant);
 *  - false: revert whatever we seeded earlier.
 */
export function rpcRelayDecision(sniperResult: string, relayUsable: boolean, sniperSeeded: boolean): "leave" | boolean {
  if (sniperResult === "skipped") return "leave";
  return relayUsable && sniperSeeded;
}
