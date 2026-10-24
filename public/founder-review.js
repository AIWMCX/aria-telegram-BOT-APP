(() => {
  'use strict';
  const tg = window.Telegram && window.Telegram.WebApp;
  const panel = document.getElementById('founder-review');
  if (!panel || !tg || !tg.initData) return;
  const field = id => document.getElementById(id);
  const result = field('review-result');
  async function api(action, values = {}) {
    const response = await fetch('/api/founder-review/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, ...values }), signal: AbortSignal.timeout(25000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Review unavailable');
    return body;
  }
  api('status').then(status => {
    panel.hidden = false;
    if (!status.verifierConfigured) result.textContent = 'Read-only verification RPC is not configured yet.';
  }).catch(() => {});
  const link = field('review-jupiter-link');
  function clearResult() { result.textContent = ''; link.hidden = true; link.removeAttribute('href'); }
  ['review-mint', 'review-side', 'review-wallet', 'review-signature'].forEach(id => field(id).addEventListener('input', clearResult));
  field('review-handoff').addEventListener('click', async () => {
    clearResult();
    try {
      const input = { mint: field('review-mint').value.trim(), side: field('review-side').value };
      const data = await api('handoff', input);
      if (input.mint !== field('review-mint').value.trim() || input.side !== field('review-side').value) { result.textContent = 'Inputs changed. Prepare the link again.'; return; }
      const url = new URL(data.url);
      if (url.origin !== 'https://jup.ag') throw new Error('Unexpected destination');
      link.href = url.href; link.hidden = false;
      result.textContent = data.note + ' Amount is not prefilled. If Telegram cannot connect your wallet, open this link in your wallet’s browser. Paste the transaction signature here afterward.';
    } catch (error) { result.textContent = error.message; }
  });
  field('review-verify').addEventListener('click', async () => {
    const button = field('review-verify'); button.disabled = true;
    link.hidden = true; result.textContent = 'Checking finalized mainnet data…';
    const input = { mint: field('review-mint').value.trim(), wallet: field('review-wallet').value.trim(), signature: field('review-signature').value.trim() };
    try {
      const { observation: o } = await api('verify', input);
      if (input.mint !== field('review-mint').value.trim() || input.wallet !== field('review-wallet').value.trim() || input.signature !== field('review-signature').value.trim()) {
        result.textContent = 'Inputs changed. Verify again.'; return;
      }
      if (o.status === 'not_found_or_not_finalized') {
        result.textContent = 'Not found at finalized commitment. This is not proof of failure. Check the signature and retry later.'; return;
      }
      if (o.status === 'failed_on_chain') {
        result.textContent = [
          'TRANSACTION FAILED ON-CHAIN — no swap happened',
          'Signature: ' + o.signature,
          'Slot: ' + o.slot,
          'Network fee (lamports): ' + o.networkFeeLamports + (o.walletPaidNetworkFee ? ' — paid by this wallet' : ' — paid by another account'),
          'Native SOL change (lamports): ' + o.nativeDeltaLamports,
          o.note,
        ].join('\n');
        return;
      }
      result.textContent = [
        'FINALIZED BALANCE OBSERVATION — not verified strategy performance',
        'Signature: ' + o.signature,
        'Wallet: ' + o.wallet,
        'Mint: ' + o.mint,
        'Slot: ' + o.slot,
        'Native SOL change (lamports): ' + o.nativeDeltaLamports,
        'Token change (raw units): ' + o.tokenDeltaRaw + ' / decimals: ' + o.tokenDecimals,
        'Transaction network fee (lamports): ' + o.networkFeeLamports,
        'This wallet paid network fee: ' + (o.walletPaidNetworkFee ? 'yes' : 'no'),
        'Realized P&L: unavailable — entry, exit and cost attribution are not reconciled.',
        o.note,
        'Wallet ownership and Jupiter execution provenance are not established by submitting a public signature.',
      ].join('\n');
    } catch (error) { result.textContent = error.message; }
    finally { button.disabled = false; }
  });
  // ---- Round trip (buy + sell): textContent-only rendering, SOL with 9 decimals plus raw lamports. ----
  const pairResult = field('review-pair-result');
  const pairIds = ['review-mint', 'review-wallet', 'review-buy-signature', 'review-sell-signature'];
  function clearPair() { pairResult.textContent = ''; }
  pairIds.forEach(id => field(id).addEventListener('input', clearPair));
  function sol(lamports) {
    const n = BigInt(lamports), neg = n < 0n, a = neg ? -n : n;
    return (neg ? '-' : '') + (a / 1000000000n).toString() + '.' + (a % 1000000000n).toString().padStart(9, '0') + ' SOL';
  }
  const money = (label, lamports) => label + ': ' + sol(lamports) + ' (' + lamports + ' lamports)';
  function tokens(raw, decimals) {
    const n = BigInt(raw), d = BigInt(decimals), base = 10n ** d;
    return (n / base).toString() + (d > 0n ? '.' + (n % base).toString().padStart(Number(d), '0') : '') + ' (' + raw + ' raw)';
  }
  const REASONS = {
    same_signature: 'Buy and sell signatures are identical.',
    sell_not_after_buy: 'The sell is not after the buy (order swapped?).',
    same_slot_ambiguous_order: 'Both transactions are in the same slot, so the order is ambiguous.',
    buy_did_not_increase_token: 'The buy did not increase this wallet’s balance of the mint.',
    sell_did_not_decrease_token: 'The sell did not decrease this wallet’s balance of the mint.',
    sold_more_than_bought: 'The sell moved more tokens than the buy acquired; pairing is not sound.',
  };
  function renderPair(r) {
    if (r.status === 'not_found_or_not_finalized') return 'Not found at finalized commitment (' + r.missing.join(', ') + '). This is not proof of failure. Retry later.';
    if (r.status === 'rejected') return 'NOT A ROUND TRIP — no P&L shown\n' + (REASONS[r.reason] || 'Rejected.') + '\n' + r.note;
    if (r.status === 'failed_side') return 'TRANSACTION FAILED ON-CHAIN (' + r.failedSides.join(', ') + ') — no round trip, no P&L\n' + r.note;
    if (r.status !== 'round_trip_observation') return 'Unexpected response.';
    return [
      'ONE OBSERVED ROUND TRIP — not strategy performance',
      'Wallet: ' + r.wallet, 'Mint: ' + r.mint,
      'Buy: ' + r.buySignature + ' (slot ' + r.buySlot + ')',
      'Sell: ' + r.sellSignature + ' (slot ' + r.sellSlot + ')',
      money('Buy native change', r.buyNativeDeltaLamports),
      money('Sell native change', r.sellNativeDeltaLamports),
      money('ROUND-TRIP NET', r.roundTripNetLamports),
      money('Network fees paid by wallet', r.feesPaidByWalletLamports) + ' [buy ' + r.buyFeeLamports + (r.buyWalletPaidFee ? '' : ', not wallet') + '; sell ' + r.sellFeeLamports + (r.sellWalletPaidFee ? '' : ', not wallet') + ']',
      money('Token account rent deposit', r.rentDepositLamports) + (r.rentDepositLamports === '0' ? '' : r.rentRefundedInSell ? ' — refunded in sell: ' + sol(r.rentRefundedLamports) : ' — NOT refunded, locked in the open token account: ' + sol(r.rentLockedLamports)),
      money('Residual: ' + r.priceAndOtherLabel, r.priceAndOtherLamports),
      'Tokens in: ' + tokens(r.tokenInRaw, r.decimals),
      'Tokens out: ' + tokens(r.tokenOutRaw, r.decimals),
      'Tokens remaining: ' + tokens(r.tokenRemainingRaw, r.decimals),
      r.note,
      'Wallet ownership and Jupiter execution provenance are not established by submitting public signatures.',
    ].join('\n');
  }
  field('review-pair').addEventListener('click', async () => {
    const button = field('review-pair'); button.disabled = true;
    pairResult.textContent = 'Checking finalized mainnet data…';
    const read = () => ({ mint: field('review-mint').value.trim(), wallet: field('review-wallet').value.trim(), buySignature: field('review-buy-signature').value.trim(), sellSignature: field('review-sell-signature').value.trim() });
    const input = read();
    try {
      const { reconciliation } = await api('pair', input);
      const now = read();
      if (Object.keys(input).some(k => input[k] !== now[k])) { pairResult.textContent = 'Inputs changed. Reconcile again.'; return; }
      pairResult.textContent = renderPair(reconciliation);
    } catch (error) { pairResult.textContent = error.message; }
    finally { button.disabled = false; }
  });
})();
