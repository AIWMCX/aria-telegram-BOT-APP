import { loadEngineConfig, redactEngineConfig } from "./config.js";
import { validateLicense } from "./license.js";
import { SolanaRpc } from "./rpc.js";
import { Engine } from "./engine.js";
import { ControlLoop } from "./control-loop.js";
import { AuthenticatedClient, exchangePairingCode } from "./authenticated-client.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "doctor";
  const config = loadEngineConfig(process.env);
  const license = () => validateLicense(config.ARIA_ENGINE_LICENSE, process.env.ARIA_LICENSE_PUBLIC_X ?? "", new Date());
  const rpc = new SolanaRpc(config.ARIA_ENGINE_RPC_URL, config.ARIA_ENGINE_NETWORK);
  if (command === "pair") {
    const result = await exchangePairingCode(config.ARIA_ENGINE_API_URL, requiredArgument("--code"));
    console.log(JSON.stringify({ paired: true, deviceId: result.deviceId }));
    return;
  }
  if (command === "doctor") {
    const identity = await rpc.readIdentity();
    const balance = await rpc.readPublicBalance(config.ARIA_ENGINE_PUBLIC_ADDRESS);
    console.log(JSON.stringify({ ...redactEngineConfig(config), network: identity.network, slot: identity.slot.toString(), publicAddress: balance.address, balanceLamports: balance.lamports.toString(), licenseStatus: license().status }));
    return;
  }
  const result = license();
  if (result.status !== "valid") throw new Error("licence is not valid");
  const engine = new Engine({ rpc, publicAddress: config.ARIA_ENGINE_PUBLIC_ADDRESS, strategy: { buyAmountSol: Math.min(result.limits.maxBuySol, 0.01), maxPositions: Math.min(result.limits.maxPositions, 1), maxSlippageBps: 200, stopLossPct: 20, takeProfit1Pct: 80, takeProfit2Pct: 200, trailingStopPct: 10, minimumLiquiditySol: 500, maximumTokenAgeSeconds: 300, safetyFilters: { requireRevokedAuthorities: true, requireSocials: true } }, license: () => license().status });
  if (command === "start-paper") { await engine.start(); await new ControlLoop(new AuthenticatedClient(config.ARIA_ENGINE_API_URL, requiredArgument("--credential")), engine).run(); return; }
  if (command === "stop") { await engine.stop(); return; }
  throw new Error("unknown command");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "engine failed"); process.exitCode = 1; });
