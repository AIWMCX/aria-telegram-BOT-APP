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
          'Network fee charged (lamports): ' + o.networkFeeLamports,
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
})();
