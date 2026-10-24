import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAINNET_GENESIS, ROUND_TRIP_MAX_CALLS, RPC_CALL_TIMEOUT_MS, reconcileRoundTrip, verifyRoundTrip } from '../src/external-review/verification.js';
import { externalReviewRoutes } from '../src/external-review/routes.js';

// Real finalized mainnet transactions (public on-chain data), fetched read-only via getTransaction jsonParsed.
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/roundtrip-${n}.json`, import.meta.url), 'utf8'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const buy = load('buy'), sell = load('sell');
const wallet = '8SdXnmXshSLKj7K6moiu9io2CwFCpcu46YKCAJLKEYxN';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const buySig = '4f6CySDH5EtueSm27gVQKdRvvtdPLbrL1ep9NHRPBjQFkDCv88ifk5zVdTKDLT3jRL1YZxrkMbsGMmTaydwfoQVZ';
const sellSig = 'rFjf1bS634pkxDqnhbdCB3nAf9SJDn4CKFg8Jv5FswDsBGC322j8z623VgEne9iAuJjoxw4HBdfTG3qo1pQ6qje';
const run = (b = buy, s = sell, bs = buySig, ss = sellSig, w = wallet, m = usdc) => reconcileRoundTrip(b, s, bs, ss, w, m);

// Exact values derived from chain data.
const r: any = run();
assert.equal(r.status, 'round_trip_observation', 'status');
assert.equal(r.buyNativeDeltaLamports, '-101638457', 'buy native delta');
assert.equal(r.sellNativeDeltaLamports, '99875829', 'sell native delta');
assert.equal(r.roundTripNetLamports, '-1762628', 'net');
assert.equal(r.buyFeeLamports, '150017'); assert.equal(r.sellFeeLamports, '150000');
assert.equal(r.buyWalletPaidFee, true); assert.equal(r.sellWalletPaidFee, true);
assert.equal(r.feesPaidByWalletLamports, '300017', 'wallet fees');
assert.equal(r.tokenInRaw, '10261697'); assert.equal(r.tokenOutRaw, '10260000'); assert.equal(r.tokenRemainingRaw, '1697');
assert.equal(r.decimals, 6);
assert.equal(r.rentDepositLamports, '1488440', 'rent detection');
assert.equal(r.rentRefundedInSell, false, 'rent not refunded');
assert.equal(r.rentLockedLamports, '1488440');
assert.equal(r.priceAndOtherLamports, '25829', 'residual');
assert.match(r.priceAndOtherLabel, /not separable without instruction decoding/);
assert.match(r.note, /not strategy performance/); assert.match(r.note, /refundable/);
assert.equal(BigInt(r.roundTripNetLamports), -BigInt(r.feesPaidByWalletLamports) - BigInt(r.rentLockedLamports) + BigInt(r.priceAndOtherLamports));
assert.equal(r.rentAccounts.length, 1);

// Ordering: swapped order must be rejected, never produce P&L.
const swapped: any = run(sell, buy, sellSig, buySig);
assert.equal(swapped.status, 'rejected'); assert.equal(swapped.reason, 'sell_not_after_buy', 'ordering check'); assert.equal(swapped.roundTripNetLamports, null);
// Same slot is ambiguous.
const sameSlot = clone(sell); sameSlot.slot = buy.slot;
assert.equal((run(buy, sameSlot) as any).reason, 'same_slot_ambiguous_order');
// Same signature twice.
assert.equal((run(buy, buy, buySig, buySig) as any).reason, 'same_signature');
// Wrong wallet (not a signer) and wrong mint (wallet holds none) throw.
assert.throws(() => run(buy, sell, buySig, sellSig, '11111111111111111111111111111111'));
assert.throws(() => run(buy, sell, buySig, sellSig, wallet, 'So11111111111111111111111111111111111111112'));
assert.throws(() => run(buy, sell, buySig, sellSig, wallet, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'));
// Failed side: status only, no P&L.
for (const side of ['buy', 'sell'] as const) {
  const f = clone(side === 'buy' ? buy : sell); f.meta.err = { InstructionError: [0, 'Custom'] };
  const out: any = side === 'buy' ? run(f, sell) : run(buy, f);
  assert.equal(out.status, 'failed_side'); assert.deepEqual(out.failedSides, [side]); assert.equal(out.roundTripNetLamports, null);
  assert.equal(out.priceAndOtherLamports, undefined);
}
// Sell without prior buy token: sell leg does not reduce the wallet's token balance.
const noTok = clone(sell); noTok.meta.postTokenBalances = noTok.meta.preTokenBalances;
assert.equal((run(buy, noTok) as any).reason, 'sell_did_not_decrease_token');
// Buy leg that did not increase the token.
const noBuy = clone(buy); noBuy.meta.postTokenBalances = noBuy.meta.preTokenBalances;
assert.throws(() => run(noBuy, sell), /Expected token absent/);
const flatBuy = clone(buy); flatBuy.meta.preTokenBalances.push(clone(flatBuy.meta.postTokenBalances.find((t: any) => t.owner === wallet)));
assert.equal((run(flatBuy, sell) as any).reason, 'buy_did_not_increase_token');
// Rent facts: mainnet getMinimumBalanceForRentExemption(165) = 1,488,440 lamports (the older 2,039,280 figure is
// stale), so the rent deposit above and the +25,829 residual (net + wallet fees + unrefunded rent) are correct.
// A refund is only counted when the sell's parsed spl-token closeAccount names this wallet as destination.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const third = sell.transaction.message.accountKeys[1].pubkey;
const closeIx = (account: string, destination: string, programId = TOKEN_PROGRAM) =>
  ({ program: 'spl-token', programId, parsed: { type: 'closeAccount', info: { account, destination, owner: wallet } }, stackHeight: null });
const rentAcct: string = r.rentAccounts[0];
type Close = { ix?: any; where?: 'outer' | 'inner'; toWallet?: boolean; postLamports?: number; inPre?: boolean };
function makeClosed(o: Close) {
  const c = clone(sell);
  const idx = c.transaction.message.accountKeys.findIndex((k: any) => k.pubkey === rentAcct);
  assert.ok(idx >= 0, 'token account present in sell');
  c.meta.postTokenBalances = c.meta.postTokenBalances.filter((t: any) => t.accountIndex !== idx);
  const entry = c.meta.preTokenBalances.find((t: any) => t.accountIndex === idx);
  entry.uiTokenAmount.amount = '10261697';
  if (o.inPre === false) { entry.accountIndex = 2; } // the wallet's tokens sit in some other account; the rent account is absent from pre
  const lamports = c.meta.preBalances[idx];
  c.meta.postBalances[idx] = o.postLamports ?? 0;
  if (o.toWallet) c.meta.postBalances[0] += lamports - c.meta.postBalances[idx];
  if (o.ix) {
    if (o.where === 'inner') c.meta.innerInstructions = [...(c.meta.innerInstructions ?? []), { index: 0, instructions: [o.ix] }];
    else c.transaction.message.instructions.push(o.ix);
  }
  return c;
}
const expectRefund = (x: any, label: string) => {
  assert.equal(x.rentRefundedInSell, true, label + ' refunded'); assert.equal(x.rentRefundedLamports, '1488440', label + ' refunded lamports');
  assert.equal(x.rentLockedLamports, '0', label + ' locked'); assert.equal(x.rentRefundUnverified, false, label + ' unverified');
  assert.equal(x.rentLostToOtherAccountLamports, '0', label + ' lost'); assert.equal(x.tokenRemainingRaw, '0', label + ' remaining');
  assert.equal(x.priceAndOtherLamports, '25829', label + ' residual');
};
expectRefund(run(buy, makeClosed({ ix: closeIx(rentAcct, wallet), toWallet: true })), 'outer closeAccount to wallet');
expectRefund(run(buy, makeClosed({ ix: closeIx(rentAcct, wallet), where: 'inner', toWallet: true })), 'inner closeAccount to wallet');
// Closed to a third party: not refunded to the wallet, reported as lost, never locked.
const lost: any = run(buy, makeClosed({ ix: closeIx(rentAcct, third) }));
assert.equal(lost.rentRefundedInSell, false, 'third-party close refunded'); assert.equal(lost.rentRefundedLamports, '0');
assert.equal(lost.rentLockedLamports, '0', 'third-party close locked'); assert.equal(lost.rentLostToOtherAccountLamports, '1488440', 'third-party close lost');
assert.equal(lost.rentRefundUnverified, false); assert.equal(lost.priceAndOtherLamports, '25829');
// Close cannot be found or decoded: flagged unverified, never counted as refunded.
const unverifiedCases: Array<[string, Close]> = [
  ['no closeAccount instruction', { toWallet: true }],
  ['non-token program', { ix: closeIx(rentAcct, wallet, '11111111111111111111111111111111'), toWallet: true }],
  ['closeAccount for another account', { ix: closeIx(third, wallet), toWallet: true }],
];
for (const [label, o] of unverifiedCases) {
  const u: any = run(buy, makeClosed(o));
  assert.equal(u.rentRefundUnverified, true, label + ' unverified flag'); assert.equal(u.rentRefundedInSell, false, label + ' refunded');
  assert.equal(u.rentRefundedLamports, '0', label + ' refunded lamports'); assert.equal(u.rentUnverifiedLamports, '1488440', label + ' unverified lamports');
}
// The account must be drained to zero and be present in the sell's pre token balances to count as closed.
for (const [label, o] of [['post balance not zero', { ix: closeIx(rentAcct, wallet), toWallet: true, postLamports: 1 }], ['absent from pre token balances', { ix: closeIx(rentAcct, wallet), toWallet: true, inPre: false }]] as Array<[string, Close]>) {
  const n: any = run(buy, makeClosed(o));
  assert.equal(n.rentRefundedInSell, false, label + ' refunded'); assert.equal(n.rentRefundedLamports, '0', label + ' refunded lamports');
  assert.equal(n.rentLockedLamports, '1488440', label + ' locked'); assert.equal(n.rentRefundUnverified, false, label + ' unverified');
}
// Selling more than was bought is not a sound pairing.
const oversold = clone(sell);
oversold.meta.preTokenBalances.find((t: any) => t.owner === wallet).uiTokenAmount.amount = '20000000';
assert.equal((run(buy, oversold) as any).reason, 'sold_more_than_bought', 'sold_more_than_bought rejection');
// Fee totals count only fees the wallet actually paid: wallet is a signer but not the fee payer on the buy.
const swapFee = clone(buy);
const keys = swapFee.transaction.message.accountKeys; [keys[0], keys[1]] = [keys[1], keys[0]];
for (const k of ['preBalances', 'postBalances']) { const a = swapFee.meta[k]; [a[0], a[1]] = [a[1], a[0]]; }
const nf: any = run(swapFee, sell);
assert.equal(nf.buyWalletPaidFee, false, 'buy fee payer is another account'); assert.equal(nf.sellWalletPaidFee, true);
assert.equal(nf.feesPaidByWalletLamports, '150000', 'fee totals respect walletPaid');
assert.equal(nf.roundTripNetLamports, '-1762628'); assert.equal(nf.priceAndOtherLamports, '-124188', 'residual with other-account fee payer');
// Honesty text: residual label, remainder caveat.
assert.match(r.priceAndOtherLabel, /platform\/route fees/); assert.match(r.residualCaveat, /unsold token remainder is valued at 0/);
assert.match(r.residualCaveat, /partial sell understates the residual/); assert.match(r.note, /partial sell understates/);
assert.ok(readFileSync(new URL('../public/founder-review.js', import.meta.url), 'utf8').includes('r.residualCaveat'), 'panel renders residualCaveat');
// Timing: the client timeout must exceed the server worst case (genesis + two transactions).
const clientTimeout = Number(/AbortSignal\.timeout\((\d+)\)/.exec(readFileSync(new URL('../public/founder-review.js', import.meta.url), 'utf8'))![1]);
assert.ok(clientTimeout > RPC_CALL_TIMEOUT_MS * ROUND_TRIP_MAX_CALLS, 'client timeout exceeds server worst case');
// A token account that already existed before the buy is not rent created by the buy.
const pre = clone(buy); pre.meta.preTokenBalances.push({ ...pre.meta.postTokenBalances.find((t: any) => t.owner === wallet), uiTokenAmount: { amount: '0', decimals: 6 } });
assert.equal((run(pre, sell) as any).rentDepositLamports, '0');

// verifyRoundTrip: one genesis check, finalized + jsonParsed + version 0, two getTransaction calls.
const calls: any[] = [];
const rpc = (genesis: string, map: Record<string, unknown>) => (async (_u: unknown, o: any) => {
  const q = JSON.parse(o.body); calls.push(q);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: q.method === 'getGenesisHash' ? genesis : (map[q.params[0]] ?? null) }));
}) as typeof fetch;
const v: any = await verifyRoundTrip('https://rpc.example', buySig, sellSig, wallet, usdc, rpc(MAINNET_GENESIS, { [buySig]: buy, [sellSig]: sell }));
assert.equal(v.roundTripNetLamports, '-1762628');
assert.deepEqual(calls.map(c => c.method), ['getGenesisHash', 'getTransaction', 'getTransaction']);
for (const c of calls.slice(1)) assert.deepEqual(c.params[1], { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 });
await assert.rejects(() => verifyRoundTrip('https://rpc.example', buySig, sellSig, wallet, usdc, rpc('devnet', {})));
assert.deepEqual(((await verifyRoundTrip('https://rpc.example', buySig, sellSig, wallet, usdc, rpc(MAINNET_GENESIS, { [buySig]: buy }))) as any).missing, ['sell']);

// Route: same gate/limits as /verify.
const deps = { enabled: true, founderId: '42', rpcUrl: 'https://rpc.example', authenticate: () => ({ user: { id: 42 }, auth_date: Math.floor(Date.now() / 1000) }), pair: async () => r };
const post = (a: ReturnType<typeof externalReviewRoutes>, body: unknown) => a.request('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const body = { initData: 'synthetic-auth', wallet, mint: usdc, buySignature: buySig, sellSignature: sellSig };
const ok = await post(externalReviewRoutes(deps), body);
assert.equal(ok.status, 200); assert.equal(((await ok.json()) as any).reconciliation.roundTripNetLamports, '-1762628');
assert.equal((await post(externalReviewRoutes(deps), { ...body, privateKey: 'x' })).status, 400);
assert.equal((await post(externalReviewRoutes(deps), { ...body, signature: buySig })).status, 400);
assert.equal((await post(externalReviewRoutes(deps), { ...body, sellSignature: undefined })).status, 400);
assert.equal((await post(externalReviewRoutes({ ...deps, enabled: false }), body)).status, 404);
assert.equal((await post(externalReviewRoutes({ ...deps, founderId: '43' }), body)).status, 403);
assert.equal((await post(externalReviewRoutes({ ...deps, rpcUrl: undefined }), body)).status, 503);
assert.equal((await post(externalReviewRoutes(deps), { ...body, pad: 'x'.repeat(13_000) })).status, 413);
const failing = await post(externalReviewRoutes({ ...deps, pair: async () => { throw new Error('secret https://rpc.example?key=abc'); } }), body);
assert.equal(failing.status, 422); assert.ok(!JSON.stringify(await failing.json()).includes('abc'));
const limited = externalReviewRoutes(deps);
for (let i = 0; i < 10; i++) await post(limited, body);
assert.equal((await post(limited, body)).status, 429);
// Busy flag: a concurrent second request is rejected while one is in flight.
let release!: () => void;
const slow = externalReviewRoutes({ ...deps, pair: () => new Promise<any>(res => { release = () => res(r); }) });
const first = post(slow, body); await new Promise(res => setTimeout(res, 20));
assert.equal((await post(slow, body)).status, 429); release(); assert.equal((await first).status, 200);
console.log('Round trip: real mainnet fixtures reconcile exactly; ordering, signature, wallet, mint, failed-side, rent and route checks passed.');
