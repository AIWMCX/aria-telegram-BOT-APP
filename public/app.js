(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ── Telegram WebApp init ───────────────────────────────────────────────
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor("#0a0c0d");
      tg.setBackgroundColor("#0a0c0d");
    } catch {
      /* older Telegram clients may not support header/background color APIs */
    }
  }
  const initData = (tg && tg.initData) || "";
  const isInTelegram = Boolean(initData);

  // Mirrors src/config.ts TIER_LIMITS — used only to render the license bar
  // client-side after a real signup response; never used for enforcement.
  const TIER_LIMITS = {
    trial:    { label: "FREE",     buy: "0.02 SOL",  pos: "5",  total: "0.1 SOL" },
    standard: { label: "STANDARD", buy: "0.01 SOL",  pos: "5",  total: "0.05 SOL" },
    pro:      { label: "PRO",      buy: "0.05 SOL",  pos: "10", total: "0.5 SOL" },
  };

  function applyLicenseBar({ email, tier, expiresAt }) {
    const cfg = TIER_LIMITS[tier] || TIER_LIMITS.trial;
    $("lic-sub").textContent = email;
    $("lic-tier").textContent = cfg.label;
    const daysLeft = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
    $("lic-days").textContent = daysLeft + "d";
    $("lic-buy").textContent = cfg.buy;
    $("lic-pos").textContent = cfg.pos;
    $("lic-total").textContent = cfg.total;
  }

  // ── Formatting ─────────────────────────────────────────────────────────
  const fmtSol = (n) => (n >= 0 ? "+" : "") + n.toFixed(4);
  const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  const fmtTime = (ms) => new Date(ms).toTimeString().slice(0, 8);
  const fmtAge = (ms) => {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  };
  const fmtUptime = (s) => {
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  };

  // ── State ──────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  const stats = {
    detected: 0, tooOld: 0, capacityFull: 0,
    blockedSafety: 0, blockedSocial: 0,
    queued: 0, bought: 0, sold: 0, openPositions: 0,
    paperPnlSol: 0, avgLatencyMs: 0, latencyCount: 0,
  };
  let positions = [];
  let eventCount = 0;

  // ── Demo-data generators — everything below is simulated for illustration ──
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const randMint = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join("");
  const SYMBOLS = [
    "PEPE2", "DOGGO", "WIFCAT", "SOLAI", "BONKINU", "MOONR", "TURBO", "BLAST",
    "RUGME", "GIGA", "CHAD", "FROG", "MEMECOIN", "PUMP", "VIRAL", "ALPHA",
    "DEGEN", "FLIP", "ROCKET", "APE", "SHIBSOL", "WOJAK", "BRETT", "MEW",
  ];
  const randSymbol = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)] + (Math.random() < 0.3 ? Math.floor(Math.random() * 99) : "");
  const randomLatency = () => Math.floor(200 + Math.random() * 600);
  const REJECT_SAFETY = [
    "freeze authority not revoked", "mint authority not revoked",
    "rugcheck score 9200 > 8000", "top10 concentration 78%",
    "liquidity $230 < $500", "honeypot pattern",
  ];
  const REJECT_SOCIAL = ["no twitter, no telegram", "no socials", "spam template"];

  function applyStats() {
    $("s-detected").textContent = String(stats.detected);
    $("s-traded").textContent = `${stats.queued} · ${stats.bought}`;
    const blocked = stats.blockedSafety + stats.blockedSocial + stats.tooOld + stats.capacityFull;
    $("s-blocked").textContent = blocked + " blocked / filtered";
    const latEl = $("s-latency");
    latEl.textContent = "";
    latEl.append(stats.avgLatencyMs ? String(Math.round(stats.avgLatencyMs)) : "—");
    const unit = document.createElement("span");
    unit.style.fontSize = "14px";
    unit.style.color = "var(--ink-mute)";
    unit.textContent = " ms";
    latEl.append(unit);

    const pnl = stats.paperPnlSol;
    const pnlEl = $("s-pnl");
    pnlEl.textContent = fmtSol(pnl);
    pnlEl.className = "num big " + (pnl > 0 ? "acid" : pnl < 0 ? "red" : "");
    $("s-pnl-pct").textContent = stats.bought > 0 ? `${stats.sold} closed / ${stats.openPositions} open` : "—";

    const upSec = Math.floor((Date.now() - startedAt) / 1000);
    $("uptime").textContent = "UPTIME " + fmtUptime(upSec);

    $("f-detected").textContent = String(stats.detected);
    $("f-tooOld").textContent = String(stats.tooOld);
    $("f-safety").textContent = String(stats.blockedSafety);
    $("f-social").textContent = String(stats.blockedSocial);
    $("f-queued").textContent = String(stats.queued);
    $("f-bought").textContent = String(stats.bought);
    $("f-sold").textContent = String(stats.sold);

    const hrs = Math.max(upSec / 3600, 0.0167);
    $("s-detected-rate").textContent = (stats.detected / hrs).toFixed(1) + " / hr";
  }

  function applyPositions() {
    const tbody = $("pos-body");
    tbody.textContent = "";
    if (positions.length === 0) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "no open positions";
      tr.append(td);
      tbody.append(tr);
      $("pos-count").textContent = "0 / 3";
      return;
    }
    for (const p of positions) {
      const tr = document.createElement("tr");
      const tdSymbol = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = p.symbol;
      tdSymbol.append(strong);
      const tdMint = document.createElement("td");
      tdMint.className = "mono";
      tdMint.title = p.mint;
      tdMint.textContent = `${p.mint.slice(0, 6)}…${p.mint.slice(-3)}`;
      const tdSize = document.createElement("td");
      tdSize.textContent = p.entrySol.toFixed(4);
      const tdPnl = document.createElement("td");
      tdPnl.className = p.pnlSol >= 0 ? "gain" : "loss";
      tdPnl.textContent = `${fmtSol(p.pnlSol)} (${fmtPct(p.pnlPct)})`;
      const tdAge = document.createElement("td");
      tdAge.textContent = fmtAge(p.openedAt);
      tr.append(tdSymbol, tdMint, tdSize, tdPnl, tdAge);
      tbody.append(tr);
    }
    $("pos-count").textContent = `${positions.length} / 3`;
  }

  function appendEvent(ev) {
    eventCount++;
    $("feed-count").textContent = eventCount + " events";
    const feed = $("feed");
    const t = fmtTime(ev.ts);
    let msg = "";
    switch (ev.kind) {
      case "detected": msg = `${ev.source.padEnd(7)} ${ev.mint.slice(0, 8)}…  lat ${ev.latencyMs}ms`; break;
      case "safety": msg = `${ev.mint.slice(0, 8)}…  ${ev.safe ? "✓ pass" : "✗ " + ev.reason}`; break;
      case "social": msg = `${ev.mint.slice(0, 8)}…  ${ev.passed ? "✓ " + ev.symbol : "✗ " + ev.reason}`; break;
      case "queued": msg = `→ buy queue: ${ev.symbol}`; break;
      case "buy": msg = `DEMO BUY  ${ev.symbol}  ${ev.sizeSol.toFixed(4)} SOL`; break;
      case "sell": msg = `DEMO SELL ${ev.symbol}  ${fmtSol(ev.pnlSol)} (${fmtPct(ev.pnlPct)})  via ${ev.reason}`; break;
      case "rejected": msg = `${ev.mint.slice(0, 8)}…  [${ev.stage}] ${ev.reason}`; break;
      default: msg = "";
    }
    const div = document.createElement("div");
    div.className = "ev " + ev.kind;
    const tSpan = document.createElement("span"); tSpan.className = "t"; tSpan.textContent = t;
    const kSpan = document.createElement("span"); kSpan.className = "k"; kSpan.textContent = ev.kind;
    const mSpan = document.createElement("span"); mSpan.className = "m"; mSpan.textContent = msg;
    div.append(tSpan, kSpan, mSpan);
    feed.append(div);
    while (feed.children.length > 120) feed.removeChild(feed.firstChild);
    feed.scrollTop = feed.scrollHeight;
  }

  // ── Simulation loop — demo dashboard only, no network calls, no real trades ──
  function simulateDetection() {
    const ts = Date.now();
    const mint = randMint();
    const source = Math.random() < 0.65 ? "pumpfun" : "raydium";
    const latency = randomLatency();
    stats.detected++;
    stats.avgLatencyMs = (stats.avgLatencyMs * stats.latencyCount + latency) / (stats.latencyCount + 1);
    stats.latencyCount++;
    appendEvent({ kind: "detected", ts, mint, source, latencyMs: latency });

    setTimeout(() => {
      if (Math.random() < 0.6) {
        const reason = REJECT_SAFETY[Math.floor(Math.random() * REJECT_SAFETY.length)];
        stats.blockedSafety++;
        appendEvent({ kind: "safety", ts: Date.now(), mint, safe: false, reason });
        appendEvent({ kind: "rejected", ts: Date.now(), mint, stage: "safety", reason });
        applyStats();
        return;
      }
      appendEvent({ kind: "safety", ts: Date.now(), mint, safe: true });

      if (Math.random() < 0.5) {
        const reason = REJECT_SOCIAL[Math.floor(Math.random() * REJECT_SOCIAL.length)];
        stats.blockedSocial++;
        appendEvent({ kind: "social", ts: Date.now(), mint, passed: false, reason });
        appendEvent({ kind: "rejected", ts: Date.now(), mint, stage: "social", reason });
        applyStats();
        return;
      }
      const symbol = randSymbol();
      appendEvent({ kind: "social", ts: Date.now(), mint, passed: true, symbol });

      if (positions.length >= 3) {
        stats.capacityFull++;
        appendEvent({ kind: "rejected", ts: Date.now(), mint, stage: "capacity", reason: "3/3 positions open" });
        applyStats();
        return;
      }
      stats.queued++;
      appendEvent({ kind: "queued", ts: Date.now(), symbol, mint });

      setTimeout(() => {
        const sizeSol = 0.005 + Math.random() * 0.005;
        stats.bought++;
        const pos = { mint, symbol, entrySol: sizeSol, openedAt: Date.now(), pnlSol: 0, pnlPct: 0 };
        positions.push(pos);
        stats.openPositions = positions.length;
        appendEvent({ kind: "buy", ts: Date.now(), symbol, mint, sizeSol });
        applyStats();
        applyPositions();
      }, 400 + Math.random() * 600);
    }, 200 + Math.random() * 400);
  }

  function simulatePositionTick() {
    for (const p of positions) {
      const drift = (Math.random() - 0.55) * 0.06;
      p.pnlPct = Math.max(-95, Math.min(900, p.pnlPct + drift * 100));
      p.pnlSol = p.entrySol * (p.pnlPct / 100);
    }
    const ageMs = (p) => Date.now() - p.openedAt;
    const closing = positions.filter(
      (p) => p.pnlPct >= 200 || p.pnlPct <= -25 || (p.pnlPct >= 80 && Math.random() < 0.2) || (ageMs(p) > 90_000 && Math.random() < 0.1),
    );
    for (const p of closing) {
      let reason = "TP1";
      if (p.pnlPct >= 200) reason = "TP2";
      else if (p.pnlPct <= -25) reason = "SL";
      else if (ageMs(p) > 90_000) reason = "TIME";
      stats.sold++;
      stats.paperPnlSol += p.pnlSol;
      positions = positions.filter((q) => q !== p);
      stats.openPositions = positions.length;
      appendEvent({ kind: "sell", ts: Date.now(), symbol: p.symbol, pnlSol: p.pnlSol, pnlPct: p.pnlPct, reason });
    }
    applyStats();
    applyPositions();
  }

  setInterval(() => { $("clock").textContent = new Date().toTimeString().slice(0, 8); }, 1000);
  function scheduleDetect() { simulateDetection(); setTimeout(scheduleDetect, 1500 + Math.random() * 2500); }
  setTimeout(scheduleDetect, 800);
  setInterval(simulatePositionTick, 1500);

  applyStats();
  applyPositions();

  // ── Form validation ──────────────────────────────────────────────────
  const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function formValues() {
    return {
      name: $("i-name").value.trim(),
      email: $("i-email").value.trim(),
      wallet: $("i-wallet").value.trim(),
      interest: $("i-interest").value.trim(),
      website: $("i-website").value.trim(),
    };
  }

  function validate() {
    const v = formValues();
    const valid = v.name.length >= 2 && EMAIL_RE.test(v.email) && SOLANA_RE.test(v.wallet);
    $("submit-btn").disabled = !valid;
    // btn-standard / btn-pro stay permanently disabled — not for sale yet.
    if (tg && tg.MainButton) {
      tg.MainButton.setText(valid ? "SUBMIT — GET FREE LICENSE" : "FILL FORM TO SUBMIT");
      if (valid) tg.MainButton.enable(); else tg.MainButton.disable();
    }
    return { valid, ...v };
  }

  function showFieldErr(id, show) {
    const field = $("field-" + id);
    const input = $("i-" + id);
    if (show) { field.classList.add("show-err"); input.classList.add("invalid"); input.setAttribute("aria-invalid", "true"); }
    else { field.classList.remove("show-err"); input.classList.remove("invalid"); input.removeAttribute("aria-invalid"); }
  }

  ["name", "email", "wallet", "interest"].forEach((id) => {
    const el = $("i-" + id);
    el.addEventListener("input", () => { validate(); if (id !== "interest") showFieldErr(id, false); });
    el.addEventListener("blur", () => {
      const v = el.value.trim();
      if (id === "name") showFieldErr(id, v.length > 0 && v.length < 2);
      if (id === "email") showFieldErr(id, v.length > 0 && !EMAIL_RE.test(v));
      if (id === "wallet") showFieldErr(id, v.length > 0 && !SOLANA_RE.test(v));
    });
  });

  function showStatus(kind, text) {
    const s = $("status");
    s.className = "status-msg " + kind;
    s.setAttribute("role", kind === "err" ? "alert" : "status");
    s.textContent = text;
    s.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ── Trial submit — POST /api/submit, issues a real license instantly ────
  let submitInFlight = false;
  async function submitTrial() {
    if (submitInFlight) return;
    const { valid, name, email, wallet, interest, website } = validate();
    if (!valid) return;
    if (!isInTelegram) { showStatus("err", "Please open this terminal from inside the Telegram bot to submit a request."); return; }

    submitInFlight = true;
    const btn = $("submit-btn");
    btn.disabled = true;
    btn.classList.add("loading");
    btn.textContent = "SUBMITTING…";
    if (tg && tg.MainButton) { tg.MainButton.showProgress(); tg.MainButton.disable(); }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, name, email, wallet, interest: interest || undefined, website }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Submission failed");

      $("form-fields").classList.add("hidden");
      showStatus("ok", `Free license issued (${data.licenseId}). Check ${email} for your key and setup steps — you can close this terminal.`);
      applyLicenseBar({ email, tier: data.tier || "trial", expiresAt: data.expiresAt });
      if (tg) {
        if (tg.HapticFeedback && tg.HapticFeedback.notificationOccurred) tg.HapticFeedback.notificationOccurred("success");
        if (tg.MainButton) tg.MainButton.hide();
      }
    } catch (err) {
      const message = err && err.name === "AbortError" ? "Request timed out. Please try again." : (err && err.message) || "Submission failed. Please try again.";
      showStatus("err", message);
      btn.disabled = false;
      btn.classList.remove("loading");
      btn.textContent = "SUBMIT — GET FREE LICENSE";
      if (tg) {
        if (tg.HapticFeedback && tg.HapticFeedback.notificationOccurred) tg.HapticFeedback.notificationOccurred("error");
        if (tg.MainButton) { tg.MainButton.hideProgress(); tg.MainButton.enable(); }
      }
    } finally {
      clearTimeout(timeout);
      submitInFlight = false;
    }
  }

  // ── Paid checkout — POST /api/checkout, redirects to Stripe ─────────────
  async function checkout(tier) {
    if (!isInTelegram) { showStatus("err", "Please open this terminal from inside the Telegram bot to purchase."); return; }
    const { valid, name, email, wallet } = validate();
    if (!valid) {
      $("request-form").scrollIntoView({ behavior: "smooth" });
      showStatus("err", "Fill in name, email, and wallet below first, then tap the plan again.");
      return;
    }
    const btn = $("btn-" + tier);
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "REDIRECTING…";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, name, email, wallet, tier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Checkout failed");
      if (tg && tg.openLink) tg.openLink(data.checkoutUrl); else window.location.href = data.checkoutUrl;
    } catch (err) {
      showStatus("err", (err && err.message) || "Checkout failed. Please try again.");
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
  $("btn-standard").addEventListener("click", () => checkout("standard"));
  $("btn-pro").addEventListener("click", () => checkout("pro"));
  $("btn-trial").addEventListener("click", () => $("request-form").scrollIntoView({ behavior: "smooth" }));
  $("btn-trial").disabled = false;
  $("btn-trial").textContent = "SCROLL TO FORM ↓";

  $("submit-btn").addEventListener("click", submitTrial);

  if (tg && tg.MainButton) {
    tg.MainButton.setText("FILL FORM TO SUBMIT");
    tg.MainButton.color = "#b6ff3c";
    tg.MainButton.textColor = "#07090a";
    tg.MainButton.show();
    tg.MainButton.disable();
    tg.MainButton.onClick(() => {
      const form = $("request-form").getBoundingClientRect();
      if (form.top > window.innerHeight * 0.5) $("request-form").scrollIntoView({ behavior: "smooth", block: "start" });
      else submitTrial();
    });
  }

  if (!isInTelegram) {
    setTimeout(() => { showStatus("err", "⚠ Open this terminal from inside the Telegram bot to submit your request."); }, 500);
  }

  $("cta-strip").addEventListener("click", () => $("pricing").scrollIntoView({ behavior: "smooth" }));

  validate();
})();
