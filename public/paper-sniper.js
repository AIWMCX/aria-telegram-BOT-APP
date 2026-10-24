(() => {
  'use strict';
  // Paper sniper panel. PAPER ONLY. Every value from the server is written with textContent; no innerHTML anywhere.
  const tg = window.Telegram && window.Telegram.WebApp;
  const panel = document.getElementById('paper-sniper');
  if (!panel || !tg || !tg.initData) return;
  const $ = id => document.getElementById(id);
  async function api(action, values = {}) {
    const response = await fetch('/api/paper-sniper/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, ...values }), signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Paper sniper unavailable');
    return body;
  }
  function sol(lamports) {
    if (lamports === null || lamports === undefined) return 'n/a';
    const n = BigInt(lamports), neg = n < 0n, a = neg ? -n : n;
    return (neg ? '-' : '') + (a / 1000000000n).toString() + '.' + (a % 1000000000n).toString().padStart(9, '0') + ' SOL';
  }
  const pct = x => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%');
  const short = m => m.slice(0, 6) + '…' + m.slice(-4);
  const when = ts => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  function row(label, a, b) { return label.padEnd(38) + String(a).padEnd(26) + String(b); }
  function renderSummary(snap) {
    const m = snap.main, b = snap.baseline;
    const lines = [
      row('', 'MAIN', 'BASELINE'),
      row('net incl. open, open AT MARK', sol(m.netInclOpenAtMarkLamports), sol(b.netInclOpenAtMarkLamports)),
      row('net incl. open, open AT ZERO', sol(m.netInclOpenAtZeroLamports), sol(b.netInclOpenAtZeroLamports)),
      row('closed trades', m.closedTrades, b.closedTrades),
      row('win rate (closed only)', pct(m.winRate), pct(b.winRate)),
      row('max drawdown (closed only)', sol(m.maxDrawdownLamports), sol(b.maxDrawdownLamports)),
      row('open (marked / unmarked)', m.openTrades + ' (' + m.openMarked + ' / ' + m.openUnmarked + ')', b.openTrades + ' (' + b.openMarked + ' / ' + b.openUnmarked + ')'),
      row('missed: market / infra', m.missedMarket + ' / ' + m.missedInfra, b.missedMarket + ' / ' + b.missedInfra),
      row('honeypot losses', m.honeypotLosses, b.honeypotLosses),
      '',
      'exit reasons (MAIN): ' + JSON.stringify(m.exitReasons),
      'skips (not trades): ' + (snap.skipReasons.length ? snap.skipReasons.map(s => s.reason + ' ' + s.count).join(', ') : 'none'),
    ];
    if (snap.truncated) lines.push('NOTE: ledger is very large; only its newest part was read.');
    for (const w of m.warnings) lines.push('! ' + w);
    return lines.join('\n');
  }
  function renderOpen(snap) {
    if (!snap.open.length) return 'none';
    return snap.open.map(p => [p.strategy.toUpperCase(), short(p.mint), 'entry ' + sol(p.buyInLamports), 'mark ' + sol(p.markValueLamports),
      'P&L at mark ' + sol(p.pnlAtMarkLamports) + (p.graduatedUnpriced ? ' (graduated, unpriced)' : ''), when(p.entryTs)].join(' | ')).join('\n');
  }
  function renderClosed(snap) {
    if (!snap.recentClosed.length) return 'none';
    return snap.recentClosed.map(t => [t.strategy.toUpperCase(), short(t.mint), t.exitReason, 'net ' + sol(t.netLamports), Math.round(t.holdMs / 1000) + 's', when(t.exitTs)].join(' | ')).join('\n');
  }
  async function refresh() {
    try {
      const { snapshot, note } = await api('summary');
      if (!snapshot) { $('sniper-state').textContent = note || 'No data yet.'; return; }
      $('sniper-state').textContent = 'State: ' + snapshot.state.toUpperCase() + ' (' + snapshot.reason + ')';
      const sample = $('sniper-sample');
      sample.hidden = !snapshot.sample.insufficient;
      sample.textContent = snapshot.sample.insufficient
        ? 'INSUFFICIENT SAMPLE: ' + snapshot.sample.closedMain + ' closed MAIN trades, fewer than ' + snapshot.sample.min + '. This is not a gate result.' : '';
      $('sniper-summary').textContent = renderSummary(snapshot);
      $('sniper-open').textContent = renderOpen(snapshot);
      $('sniper-closed').textContent = renderClosed(snapshot);
    } catch (error) { $('sniper-state').textContent = error.message; }
  }
  async function control(action, button) {
    button.disabled = true;
    try { await api(action); await refresh(); } catch (error) { $('sniper-state').textContent = error.message; } finally { button.disabled = false; }
  }
  api('status').then(s => {
    if (!s.available) return;
    panel.hidden = false;
    $('sniper-kill').addEventListener('click', e => control('kill', e.currentTarget));
    $('sniper-resume').addEventListener('click', e => control('resume', e.currentTarget));
    $('sniper-refresh').addEventListener('click', refresh);
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  }).catch(() => {});
})();
