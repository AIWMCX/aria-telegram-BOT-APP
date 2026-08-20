import assert from "node:assert/strict";
import { SolanaRpc } from "./rpc.js";

const genesis = "EtWTRABZaYq6iMfeYKouRu166cLkZx3xw3V5hT7s2p6V";
const calls: string[] = [];
const transport = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { method: string };
  calls.push(body.method);
  const result = body.method === "getGenesisHash" ? genesis : body.method === "getSlot" ? 123 : { context: { slot: 123 }, value: 42 };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
};
const rpc = new SolanaRpc("https://rpc.example.com", "solana-devnet", transport);
assert.deepEqual(await rpc.readIdentity(), { network: "solana-devnet", slot: 123n });
assert.deepEqual(await rpc.readPublicBalance("So11111111111111111111111111111111111111112"), { address: "So11111111111111111111111111111111111111112", lamports: 42n, slot: 123n });
assert.deepEqual(calls, ["getGenesisHash", "getSlot", "getBalance"]);
assert.throws(() => new SolanaRpc("http://rpc.example.com", "solana-devnet", transport));
assert.rejects(() => rpc.readPublicBalance("not-a-wallet"), /invalid/);
console.log("engine RPC tests passed");
