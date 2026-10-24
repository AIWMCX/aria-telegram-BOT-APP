import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAINNET_GENESIS, reconcileRoundTrip, verifyRoundTrip } from '../src/external-review/verification.js';
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
// Rent refunded: sell closes the buy-created token account (synthetic variant of the real sell).
const closed = clone(sell);
const idx = closed.transaction.message.accountKeys.findIndex((k: any) => k.pubkey === r.rentAccounts[0]);
assert.ok(idx >= 0, 'token account present in sell');
closed.meta.postTokenBalances = closed.meta.postTokenBalances.filter((t: any) => t.accountIndex !== idx);
closed.meta.preTokenBalances.find((t: any) => t.accountIndex === idx).uiTokenAmount.amount = '10261697';
closed.meta.postBalances[0] += closed.meta.preBalances[idx] - closed.meta.postBalances[idx];
closed.meta.postBalances[idx] = 0;
const rc: any = run(buy, closed);
assert.equal(rc.rentRefundedInSell, true); assert.equal(rc.rentRefundedLamports, '1488440'); assert.equal(rc.rentLockedLamports, '0');
assert.equal(rc.tokenRemainingRaw, '0');
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
