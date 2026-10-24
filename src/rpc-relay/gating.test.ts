import { rpcRelayDecision } from "./gating.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failures++;
}

// prepareTenantRuntime gating (src/fleet/discovery-instance.ts): sniperResult + isSeeded + relay usable
check("sniper lookup skipped (transient) -> leave rpc.url alone", rpcRelayDecision("skipped", true, true) === "leave" && rpcRelayDecision("skipped", false, false) === "leave");
check("seeded sniper tenant + usable relay -> seed", rpcRelayDecision("enabled", true, true) === true && rpcRelayDecision("unchanged", true, true) === true);
check("relay not usable -> revert (false), even for a seeded sniper tenant", rpcRelayDecision("unchanged", false, true) === false);
check("tenant not seeded for the sniper (disabled / not allowed / no_feed / deferred) -> revert (false)",
  ["disabled", "unchanged", "no_feed", "deferred"].every((r) => rpcRelayDecision(r, true, false) === false));
check("a tenant is never seeded unless BOTH the relay is usable and the sniper seeded it", ([true, false] as const).every((u) => ([true, false] as const).every((sd) => (rpcRelayDecision("enabled", u, sd) === true) === (u && sd))));

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
