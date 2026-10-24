import assert from 'node:assert/strict';
import { Address, MAINNET_GENESIS, SOL_MINT, inspectTransaction, isBase58Bytes, jupiterLink, verifySignature } from '../src/external-review/verification.js';
import { externalReviewRoutes } from '../src/external-review/routes.js';
const wallet = '11111111111111111111111111111111';
// Use known valid 32-byte public mint; test data is synthetic throughout.
const token = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const signature = '1'.repeat(64);
const fixture = () => ({ slot: 123, blockTime: 1700000000,
  transaction: { signatures: [signature], message: { accountKeys: [
    { pubkey: wallet, signer: true, writable: true }, { pubkey: SOL_MINT, signer: false, writable: true },
  ] } },
  meta: { err: null, fee: 5000, preBalances: [10_000_000, 0], postBalances: [8_000_000, 2_000_000],
    preTokenBalances: [] as Array<{ accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number } }>, postTokenBalances: [{ accountIndex: 1, mint: token, owner: wallet, uiTokenAmount: { amount: '9007199254740993', decimals: 6 } }],
  },
});
assert(isBase58Bytes(wallet, 32)); assert(!isBase58Bytes('1'.repeat(33), 32));
assert(!Address.safeParse('https://evil.example').success);
assert(!isBase58Bytes('0'.repeat(44), 32));
const link = new URL(jupiterLink(token, 'buy'));
assert.equal(link.origin, 'https://jup.ag'); assert.equal(link.searchParams.get('buy'), token);
assert.equal(new URL(jupiterLink(token, 'sell')).searchParams.get('buy'), SOL_MINT);
assert.throws(() => jupiterLink(SOL_MINT, 'buy'));
const observed = inspectTransaction(fixture(), signature, wallet, token);
assert.equal(observed.tokenDeltaRaw, '9007199254740993');
assert.equal(observed.nativeDeltaLamports, '-2000000');
assert.equal(observed.realizedPnlLamports, null);
assert.equal(observed.swapProvenanceVerified, false);
const failed = fixture(); failed.meta.err = {} as any;
const failedObs: any = inspectTransaction(failed, signature, wallet, token);
assert.equal(failedObs.status, 'failed_on_chain');
assert.equal(failedObs.networkFeeLamports, '5000');
assert.equal(failedObs.nativeDeltaLamports, '-2000000');
// The real mainnet genesis hash, pinned literally: a truncated constant once made every real check fail.
assert.equal(MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
const missing = fixture(); missing.meta.preTokenBalances = undefined as any;
assert.throws(() => inspectTransaction(missing, signature, wallet, token));
const unsafe = fixture(); unsafe.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
assert.throws(() => inspectTransaction(unsafe, signature, wallet, token));
const unsigned = fixture(); unsigned.transaction.message.accountKeys[0].signer = false;
assert.throws(() => inspectTransaction(unsigned, signature, wallet, token));
assert.throws(() => inspectTransaction(fixture(), signature, wallet, SOL_MINT));
const mismatch = fixture(); mismatch.transaction.signatures[0] = '2'.repeat(88);
assert.throws(() => inspectTransaction(mismatch, signature, wallet, token));
const closed = fixture(); closed.meta.preTokenBalances = closed.meta.postTokenBalances; closed.meta.postTokenBalances = [];
assert.equal(inspectTransaction(closed, signature, wallet, token).tokenDeltaRaw, '-9007199254740993');
let methods: string[] = [];
const rpc = (genesis: string, tx: unknown) => (async (_url: unknown, options: any) => {
  const request = JSON.parse(options.body); methods.push(request.method);
  if (request.method === 'getTransaction') {
    assert.equal(request.params[1].commitment, 'finalized');
    assert.equal(request.params[1].encoding, 'jsonParsed');
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: request.method === 'getGenesisHash' ? genesis : tx }));
}) as typeof fetch;
assert.equal((await verifySignature('https://rpc.example', signature, wallet, token, rpc(MAINNET_GENESIS, fixture()))).status, 'finalized_balance_observation');
assert.deepEqual(methods, ['getGenesisHash', 'getTransaction']);
await assert.rejects(() => verifySignature('https://rpc.example', signature, wallet, token, rpc('devnet', fixture())));
assert.equal((await verifySignature('https://rpc.example', signature, wallet, token, rpc(MAINNET_GENESIS, null))).status, 'not_found_or_not_finalized');
const deps = { enabled: true, founderId: '42', rpcUrl: 'https://rpc.example', authenticate: () => ({ user: { id: 42 }, auth_date: Math.floor(Date.now()/1000) }), verify: async () => observed };
const app = externalReviewRoutes(deps);
const post = (app: ReturnType<typeof externalReviewRoutes>, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const auth = { initData: 'synthetic-auth' };
assert.equal((await post(app, '/status', auth)).status, 200);
assert.equal((await post(app, '/verify', { ...auth, wallet, mint: token, signature })).status, 200);
assert.equal((await post(app, '/verify', { ...auth, wallet, mint: token, signature, privateKey: 'reject' })).status, 400);
assert.equal((await post(externalReviewRoutes({ ...deps, enabled: false }), '/status', auth)).status, 404);
assert.equal((await post(externalReviewRoutes({ ...deps, founderId: '' }), '/status', auth)).status, 404);
assert.equal((await post(externalReviewRoutes({ ...deps, founderId: '43' }), '/status', auth)).status, 403);
assert.equal((await post(externalReviewRoutes({ ...deps, authenticate: () => null }), '/status', auth)).status, 403);
assert.equal((await post(externalReviewRoutes({ ...deps, rpcUrl: undefined }), '/verify', { ...auth, wallet, mint: token, signature })).status, 503);
assert.equal((await post(externalReviewRoutes({ ...deps, authenticate: () => ({ user: { id: 42 }, auth_date: 0 }) }), '/status', auth)).status, 403);
for (let i = 0; i < 10; i++) await post(app, '/handoff', { ...auth, mint: token, side: 'buy' });
assert.equal((await post(app, '/handoff', { ...auth, mint: token, side: 'buy' })).status, 429);
console.log('External review: synthetic balance, precision, RPC, authentication, fail-closed and rate-limit checks passed. No live transaction submitted.');
