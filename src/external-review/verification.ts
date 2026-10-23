import { z } from 'zod';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function isBase58Bytes(value: string, bytes: number): boolean {
  if (!value || value.length > 90) return false;
  let n = 0n;
  for (const c of value) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  let size = 0;
  while (n) { size++; n >>= 8n; }
  return size + (value.match(/^1*/)?.[0].length ?? 0) === bytes;
}
export const Address = z.string().refine(v => isBase58Bytes(v, 32), 'Expected a public Solana address');
export const Signature = z.string().refine(v => isBase58Bytes(v, 64), 'Expected a transaction signature');
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const uint = z.number().int().nonnegative().safe();
const TokenBalance = z.object({
  accountIndex: uint, mint: Address, owner: Address,
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/).max(30), decimals: uint.max(255) }),
});
const Transaction = z.object({
  slot: uint, blockTime: z.number().int().nullable(),
  transaction: z.object({ signatures: z.array(Signature).min(1), message: z.object({
    accountKeys: z.array(z.object({ pubkey: Address, signer: z.boolean(), writable: z.boolean() })).min(1),
  }) }),
  meta: z.object({
    err: z.unknown(), fee: uint,
    preBalances: z.array(uint), postBalances: z.array(uint),
    preTokenBalances: z.array(TokenBalance), postTokenBalances: z.array(TokenBalance),
  }),
});

export function jupiterLink(mint: string, side: 'buy' | 'sell'): string {
  Address.parse(mint);
  if (mint === SOL_MINT) throw new Error('Choose a non-SOL token mint');
  const url = new URL('https://jup.ag/');
  url.searchParams.set('sell', side === 'buy' ? SOL_MINT : mint);
  url.searchParams.set('buy', side === 'buy' ? mint : SOL_MINT);
  return url.toString();
}

// This verifies observed balances, NOT swap provenance, wallet ownership, or profitability.
export function inspectTransaction(raw: unknown, signature: string, wallet: string, mint: string) {
  Signature.parse(signature); Address.parse(wallet); Address.parse(mint);
  const tx = Transaction.parse(raw);
  const keys = tx.transaction.message.accountKeys;
  if (tx.transaction.signatures[0] !== signature) throw new Error('Signature mismatch');
  if (new Set(keys.map(k => k.pubkey)).size !== keys.length) throw new Error('Duplicate account keys');
  const index = keys.findIndex(k => k.pubkey === wallet && k.signer);
  if (index < 0) throw new Error('Expected wallet was not a signer');
  if (tx.meta.preBalances.length !== keys.length || tx.meta.postBalances.length !== keys.length)
    throw new Error('Incomplete native balance metadata');
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    // Failed on-chain: no trade happened, but the fee (and any priority fee) was still charged.
    const nativeDelta = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
    return {
      status: 'failed_on_chain' as const, signature, wallet, mint, slot: tx.slot, blockTime: tx.blockTime,
      nativeDeltaLamports: nativeDelta.toString(), networkFeeLamports: String(tx.meta.fee), walletPaidNetworkFee: index === 0,
      realizedPnlLamports: null,
      note: 'This transaction FAILED on-chain. No swap occurred, but the network fee was charged. Count it as a cost.',
    };
  }
  const sum = (balances: z.infer<typeof TokenBalance>[]) => {
    let total = 0n;
    let decimals: number | undefined;
    const seen = new Set<number>();
    for (const balance of balances) {
      if (balance.accountIndex >= keys.length || seen.has(balance.accountIndex)) throw new Error('Invalid token account metadata');
      seen.add(balance.accountIndex);
      if (balance.owner !== wallet || balance.mint !== mint) continue;
      if (decimals !== undefined && decimals !== balance.uiTokenAmount.decimals) throw new Error('Token decimal mismatch');
      decimals = balance.uiTokenAmount.decimals;
      total += BigInt(balance.uiTokenAmount.amount);
    }
    return { total, decimals };
  };
  const pre = sum(tx.meta.preTokenBalances), post = sum(tx.meta.postTokenBalances);
  if (pre.decimals === undefined && post.decimals === undefined) throw new Error('Expected token absent');
  if (pre.decimals !== undefined && post.decimals !== undefined && pre.decimals !== post.decimals)
    throw new Error('Token decimal mismatch');
  const tokenDelta = post.total - pre.total;
  const nativeDelta = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
  return {
    status: 'finalized_balance_observation' as const, signature, wallet, mint, slot: tx.slot, blockTime: tx.blockTime,
    nativeDeltaLamports: nativeDelta.toString(), tokenDeltaRaw: tokenDelta.toString(),
    tokenDecimals: post.decimals ?? pre.decimals,
    networkFeeLamports: String(tx.meta.fee), walletPaidNetworkFee: index === 0,
    direction: tokenDelta > 0n && nativeDelta < 0n ? 'acquisition_like' : tokenDelta < 0n && nativeDelta > 0n ? 'disposal_like' : 'other',
    realizedPnlLamports: null, swapProvenanceVerified: false, walletOwnershipVerified: false,
    note: 'Balance changes include transfers, rent and other instructions. Network fees are already reflected when this wallet paid them. These deltas alone do not establish a swap or P&L.',
  };
}

export async function verifySignature(rpcUrl: string, signature: string, wallet: string, mint: string, fetcher: typeof fetch = fetch) {
  Signature.parse(signature); Address.parse(wallet); Address.parse(mint);
  const call = async (method: string, params: unknown[]) => {
    const response = await fetcher(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('RPC unavailable');
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('RPC response too large');
    const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown(), error: z.unknown().optional() }).parse(JSON.parse(body));
    if (envelope.error !== undefined) throw new Error('RPC rejected request');
    return envelope.result;
  };
  if (await call('getGenesisHash', []) !== MAINNET_GENESIS) throw new Error('RPC is not Solana mainnet');
  const raw = await call('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (raw === null) return { status: 'not_found_or_not_finalized' as const };
  return inspectTransaction(raw, signature, wallet, mint);
}
