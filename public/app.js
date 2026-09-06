(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0a0c0d"); tg.setBackgroundColor("#0a0c0d"); } catch {}
  }
  const initData = (tg && tg.initData) || "";
  const isInTelegram = Boolean(initData);

  const SAFE_REALITY = Object.freeze({
    environment: "production",
    network: "offline",
    dataMode: "unavailable",
    executionMode: "paper",
    controlState: "stopped",
    paymentsEnabled: false,
  });
  const VALID = {
    environment: new Set(["production", "staging", "development"]),
    network: new Set(["offline", "solana-devnet", "solana-mainnet"]),
    dataMode: new Set(["unavailable", "simulated", "live"]),
    executionMode: new Set(["disabled", "paper", "devnet", "mainnet"]),
    controlState: new Set(["stopped", "starting", "running", "stopping"]),
  };
  const NETWORK_LABEL = { offline: "OFFLINE", "solana-devnet": "SOLANA DEVNET", "solana-mainnet": "SOLANA MAINNET" };
  const DATA_LABEL = { unavailable: "WAITING FOR ENGINE", simulated: "SIMULATED", live: "REAL MARKET DATA" };
  const EXECUTION_LABEL = { disabled: "EXECUTION DISABLED", paper: "PAPER EXECUTION", devnet: "DEVNET EXECUTION", mainnet: "MAINNET EXECUTION" };

  function validateRealityPayload(payload) {
    if (!payload || payload.ok !== true || !payload.reality || typeof payload.reality !== "object") return null;
    const r = payload.reality;
    if (!["environment", "network", "dataMode", "executionMode", "controlState"].every((key) => VALID[key].has(r[key])) || typeof r.paymentsEnabled !== "boolean") return null;
    return Object.freeze({ environment: r.environment, network: r.network, dataMode: r.dataMode, executionMode: r.executionMode, controlState: r.controlState, paymentsEnabled: r.paymentsEnabled });
  }

  function renderReality(reality) {
    $("data-mode").textContent = DATA_LABEL[reality.dataMode];
    $("network-mode").textContent = NETWORK_LABEL[reality.network];
    $("execution-mode").textContent = EXECUTION_LABEL[reality.executionMode];
    $("control-state").textContent = reality.controlState.toUpperCase();
    $("reality-banner").textContent = reality.dataMode === "live"
      ? `REAL MAINNET MARKET DATA · ${EXECUTION_LABEL[reality.executionMode]} · NO REAL ORDERS`
      : `REAL-1 · ${EXECUTION_LABEL[reality.executionMode]} · NO REAL ORDERS`;
  }

  async function loadReality() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch("/api/product-reality", { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("reality unavailable");
      renderReality(validateRealityPayload(await response.json()) || SAFE_REALITY);
    } catch { renderReality(SAFE_REALITY); }
    finally { clearTimeout(timer); }
  }
  renderReality(SAFE_REALITY);
  void loadReality();

  // One-time PAPER-mode explanation — shown once per device, never again
  // unless the user clears site storage. localStorage is per-viewer/per-
  // device by design here (no server round trip needed for a UI-only
  // "have I seen this" flag).
  (function showPaperExplainerOnce() {
    let alreadySeen = false;
    try { alreadySeen = localStorage.getItem("aria_paper_explained") === "1"; } catch {}
    const panel = $("paper-explainer");
    if (!panel) return;
    if (!alreadySeen) panel.hidden = false;
    const dismissBtn = $("paper-explainer-dismiss");
    if (dismissBtn) dismissBtn.addEventListener("click", () => {
      panel.hidden = true;
      try { localStorage.setItem("aria_paper_explained", "1"); } catch {}
    });
  })();

  function text(id, value) { const el = $(id); if (el) el.textContent = value; }
  function lamportsToSol(value) {
    try { return (Number(BigInt(String(value || "0"))) / 1_000_000_000).toFixed(6); } catch { return "—"; }
  }
  function timeAgo(iso) {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "unknown";
    if (ms < 0) return "just now";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ago`;
  }
  function setTableUnavailable(message) {
    const tbody = $("pos-body");
    tbody.textContent = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = message;
    tr.append(td);
    tbody.append(tr);
  }
  function clearPaperSnapshot() {
    for (const id of ["s-detected", "s-traded", "s-latency", "s-pnl", "f-detected", "f-tooOld", "f-safety", "f-social", "f-queued", "f-bought", "f-sold"]) text(id, "—");
    text("s-detected-rate", "engine unavailable");
    text("s-blocked", "engine unavailable");
    text("s-pnl-pct", "real engine snapshot");
    text("uptime", "WAITING FOR ENGINE");
    text("pos-count", "—");
    setTableUnavailable("No open positions yet — connect your engine above, then ARIA will show real activity here as it happens.");
    $("feed").textContent = "";
    text("feed-count", "0 events");
  }

  function engineRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const headers = Object.assign({ Accept: "application/json" }, options.headers || {});
    return fetch(path, Object.assign({}, options, { headers, signal: controller.signal })).finally(() => clearTimeout(timer));
  }

  function renderEngineDisconnected(message = "Connect your ARIA engine — the button below generates a pairing code, no chat command needed.") {
    text("engine-connection", "DISCONNECTED");
    text("engine-status", message);
    text("engine-network", "—");
    text("engine-address", "—");
    text("engine-balance", "—");
    $("engine-start-btn").disabled = true;
    $("engine-pause-btn").disabled = true;
    $("engine-stop-btn").disabled = true;
    clearPaperSnapshot();
  }

  // Real reason codes from aria-engine's evaluatePaperRisk() (src/paper/paper-risk.ts)
  // — every candidate rejection carries one of exactly these, synced through
  // event.data.reason. Kept in sync with that file's 8 checks; if a new
  // reason code is ever added there, it falls back to the raw code string
  // below rather than showing nothing.
  const REJECTION_REASONS = {
    "stale-observation": ["Price data too old", "The market data for this token was too old to trust safely — ARIA only trades on fresh prices."],
    "invalid-input": ["Malformed candidate", "This candidate didn't pass basic validity checks (bad token address)."],
    "invalid-price": ["Invalid price", "The quoted price wasn't a real, usable number."],
    "duplicate-candidate": ["Already seen", "ARIA already evaluated this exact candidate — skipped to avoid double-counting."],
    "position-cap": ["Position limit reached", "ARIA is already holding the maximum number of paper positions allowed."],
    "daily-loss-limit": ["Daily loss limit hit", "Today's realized paper losses hit the configured cap — new entries pause until tomorrow (open positions still exit normally)."],
    "mint-cooldown": ["Cooldown active", "This token was traded too recently — ARIA waits out a cooldown before re-entering the same token."],
    "exposure-cap": ["Exposure cap reached", "Taking this position would push total paper exposure over the configured cap."],
  };
  const REJECTION_EVENT_TYPES = new Set(["paper-candidate-rejected", "paper-capacity-rejected", "paper-stale-data"]);

  function renderPaperEvents(events) {
    const feed = $("feed");
    const engineFeed = $("engine-events");
    feed.textContent = "";
    engineFeed.textContent = "";
    const list = Array.isArray(events) ? events : [];
    text("feed-count", `${list.length} events`);
    for (const event of list.slice(0, 20)) {
      const reasonCode = event.data && event.data.reason;
      const isRejection = REJECTION_EVENT_TYPES.has(event.type) && reasonCode;
      const known = isRejection ? REJECTION_REASONS[reasonCode] : undefined;
      const label = isRejection
        ? `Candidate rejected · ${known ? known[0] : reasonCode} · ${timeAgo(event.occurredAt)}`
        : `${event.type || "paper-event"} · ${timeAgo(event.occurredAt)} · PAPER`;
      for (const target of [feed, engineFeed]) {
        const row = document.createElement("div");
        row.className = "ev";
        const msg = document.createElement("span");
        msg.className = "m";
        msg.textContent = label;
        row.append(msg);
        if (isRejection) {
          row.style.cursor = "pointer";
          const detail = document.createElement("div");
          detail.className = "hint";
          detail.hidden = true;
          detail.textContent = known ? known[1] : `Reason code: ${reasonCode} (no plain-English explanation written for this one yet).`;
          row.addEventListener("click", () => { detail.hidden = !detail.hidden; });
          row.append(detail);
        }
        target.append(row);
      }
    }
  }

  function renderPaperSnapshot(snapshotEnvelope) {
    const snapshot = snapshotEnvelope && snapshotEnvelope.data;
    if (!snapshot || snapshot.mode !== "paper") { clearPaperSnapshot(); return; }
    text("s-detected", String(snapshot.openedCount ?? 0));
    text("s-traded", `${snapshot.closedCount ?? 0} · ${snapshot.rejectedCount ?? 0}`);
    text("s-latency", String(snapshot.openExposureLamports ?? "0"));
    text("s-pnl", lamportsToSol(snapshot.realizedPnlLamports));
    text("s-detected-rate", `${snapshot.openPositionCount ?? 0} open now`);
    text("s-blocked", `${snapshot.rejectedCount ?? 0} rejected by paper risk gate`);
    text("s-pnl-pct", `unrealized ${lamportsToSol(snapshot.unrealizedPnlLamports)} SOL`);
    text("uptime", `SNAPSHOT ${timeAgo(snapshotEnvelope.receivedAt)}`);
    text("f-detected", String(snapshot.openedCount ?? 0));
    text("f-tooOld", String(snapshot.closedCount ?? 0));
    text("f-safety", String(snapshot.rejectedCount ?? 0));
    text("f-social", String(snapshot.openPositionCount ?? 0));
    text("f-queued", String(snapshot.openExposureLamports ?? "0"));
    text("f-bought", String(snapshot.realizedPnlLamports ?? "0"));
    text("f-sold", String(snapshot.unrealizedPnlLamports ?? "0"));
    text("pos-count", String(snapshot.openPositionCount ?? 0));
    setTableUnavailable((snapshot.openPositionCount ?? 0) > 0
      ? `${snapshot.openPositionCount} open paper position(s) · detailed position payload is intentionally not synced in REAL-1 preview yet`
      : "No open positions — this is normal. ARIA intentionally rejects most candidates; it's waiting for one that passes the full decision pipeline.");
  }

  function renderEngineDashboard(data) {
    if (!data || data.ok !== true || !data.paired || !data.device) {
      renderEngineDisconnected();
      return;
    }
    const device = data.device;
    text("engine-connection", device.online ? "CONNECTED" : "OFFLINE");
    text("engine-status", device.online
      ? (data.entitlement ? `entitlement ${String(data.entitlement.status).toUpperCase()} · PAPER ONLY` : "entitlement unavailable")
      : "Not heard from recently — your PAPER positions and journal are safe. Make sure ARIA is running, or run `aria doctor`.");
    text("engine-network", device.platform ? String(device.platform).toUpperCase() : "LOCAL");
    text("engine-address", device.engineVersion || "unknown");
    text("engine-balance", timeAgo(device.lastSeenAt));
    const caps = data.capabilities || {};
    $("engine-start-btn").disabled = true;
    $("engine-pause-btn").disabled = !caps.paperPause;
    $("engine-stop-btn").disabled = !caps.paperStop;
    text("engine-pairing", caps.remoteColdStart === false
      ? "Connected. Start the local engine with `aria paper start`; Telegram PAUSE/STOP and live status are operational. Remote cold START comes with the supervisor build."
      : "Connected to local ARIA engine.");
    renderPaperSnapshot(data.snapshot);
    renderPaperEvents(data.events);
  }

  async function refreshEngine() {
    if (!isInTelegram) { renderEngineDisconnected("open this control center inside Telegram"); return; }
    try {
      const response = await engineRequest("/api/engine/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "engine unavailable");
      renderEngineDashboard(data);
    } catch (error) {
      renderEngineDisconnected(error && error.message ? error.message : "engine unavailable");
    }
  }

  async function pairEngine() {
    if (!isInTelegram) { text("engine-pairing", "Open this control center inside Telegram first."); return; }
    try {
      const response = await engineRequest("/api/engine/pairing-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "pairing unavailable");
      text("engine-pairing", `Run: aria pair ${data.code} · expires ${new Date(data.expiresAt).toLocaleTimeString()} · single use`);
    } catch (error) { text("engine-pairing", error && error.message ? error.message : "pairing unavailable"); }
  }

  async function commandEngine(command) {
    if (!isInTelegram) throw new Error("open inside Telegram");
    const response = await engineRequest("/api/engine/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, command }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "engine command rejected");
    text("engine-status", `${command.replace("paper_", "").toUpperCase()} queued · ${data.commandId.slice(0, 8)}…`);
    setTimeout(() => void refreshEngine(), 1200);
  }

  $("engine-pair-btn").addEventListener("click", () => void pairEngine());
  $("engine-start-btn").addEventListener("click", () => { text("engine-pairing", "Remote cold START is intentionally disabled until the signed local supervisor is installed. Run `aria paper start` locally for this preview."); });
  $("engine-pause-btn").addEventListener("click", () => void commandEngine("paper_pause").catch((e) => text("engine-status", e.message || "pause failed")));
  $("engine-stop-btn").addEventListener("click", () => void commandEngine("paper_stop").catch((e) => text("engine-status", e.message || "stop failed")));

  // Safe diagnostic bundle for support — only values already rendered on
  // screen, nothing pulled fresh from a secret-bearing endpoint. Never
  // includes a wallet address, license token, or any bearer credential.
  $("engine-diagnostics-btn").addEventListener("click", async () => {
    const diagnosticId = "ARIA-" + Math.random().toString(36).slice(2, 7).toUpperCase();
    const lines = [
      "ARIA Diagnostics",
      `Version: ${$("engine-address").textContent}`,
      `Device: ${$("engine-connection").textContent}`,
      `Mode: ${$("execution-mode").textContent}`,
      `Market data: ${$("data-mode").textContent}`,
      `Last sync: ${$("engine-balance").textContent}`,
      `Diagnostic ID: ${diagnosticId}`,
    ];
    try { await navigator.clipboard.writeText(lines.join("\n")); } catch {}
    text("engine-diagnostics-result", `Copied · ${diagnosticId} · share this with support, it contains no secrets`);
  });
  renderEngineDisconnected();
  if (isInTelegram) { void refreshEngine(); setInterval(() => void refreshEngine(), 5000); }

  // LIVE/paid interest signals — real demand data for a build-it-or-not
  // decision, not a functioning purchase or waitlist flow. Both disabled
  // tiles were previously fully inert; clicking now records intent.
  async function registerInterest(kind, btn) {
    if (!isInTelegram) { text("interest-result", "Open this inside Telegram to register interest."); return; }
    btn.disabled = true;
    try {
      const response = await fetch("/api/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, kind }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "failed");
      btn.textContent = "THANKS — NOTED";
      text("interest-result", "Recorded. This is real signal the team uses to decide what to build next.");
    } catch (error) {
      btn.disabled = false;
      text("interest-result", error && error.message ? error.message : "failed, try again");
    }
  }
  $("btn-standard").addEventListener("click", () => void registerInterest("live", $("btn-standard")));
  $("btn-pro").addEventListener("click", () => void registerInterest("paid", $("btn-pro")));

  // Feedback capture — Telegram-authenticated but not gated on invite
  // status, since the point is hearing from anyone who's stuck, not
  // just approved beta users.
  $("feedback-submit-btn").addEventListener("click", async () => {
    const textarea = $("feedback-text");
    const message = textarea.value.trim();
    if (!message) { text("feedback-result", "Write something first."); return; }
    if (!isInTelegram) { text("feedback-result", "Open this inside Telegram to send feedback."); return; }
    $("feedback-submit-btn").disabled = true;
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData, message }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "feedback failed");
      textarea.value = "";
      text("feedback-result", "Sent — thank you.");
    } catch (error) {
      text("feedback-result", error && error.message ? error.message : "feedback failed, try again");
    } finally {
      $("feedback-submit-btn").disabled = false;
    }
  });

  const TIER_LIMITS = {
    trial: { label: "FREE", buy: "0.005 SOL", pos: "3", total: "0.015 SOL" },
    standard: { label: "STANDARD", buy: "0.01 SOL", pos: "5", total: "0.05 SOL" },
    pro: { label: "PRO", buy: "0.05 SOL", pos: "10", total: "0.5 SOL" },
  };
  function applyLicenseBar({ email, tier, expiresAt }) {
    const cfg = TIER_LIMITS[tier] || TIER_LIMITS.trial;
    text("lic-sub", email);
    text("lic-tier", cfg.label);
    text("lic-days", Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)) + "d");
    text("lic-buy", cfg.buy); text("lic-pos", cfg.pos); text("lic-total", cfg.total);
  }

  const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function values() { return { name: $("i-name").value.trim(), email: $("i-email").value.trim(), wallet: $("i-wallet").value.trim(), interest: $("i-interest").value.trim(), website: $("i-website").value.trim() }; }
  function validate() { const value = values(); const valid = value.name.length >= 2 && EMAIL_RE.test(value.email) && SOLANA_RE.test(value.wallet); $("submit-btn").disabled = !valid; return { valid, ...value }; }
  async function submitTrial() {
    const value = validate();
    if (!value.valid || !isInTelegram) { text("status", !isInTelegram ? "Open inside Telegram to submit." : "Complete the required fields."); return; }
    const response = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData, ...value }) });
    const data = await response.json();
    if (!response.ok || !data.ok) { text("status", data.error || "Submission failed"); return; }
    $("form-fields").classList.add("hidden");
    text("status", `Beta access issued (${data.licenseId}). Use CREATE PAIRING CODE above to connect your local engine.`);
    applyLicenseBar({ email: value.email, tier: data.tier || "trial", expiresAt: data.expiresAt });
  }
  $("submit-btn").addEventListener("click", () => void submitTrial());
  ["name", "email", "wallet", "interest"].forEach((id) => $("i-" + id).addEventListener("input", validate));
  $("btn-trial").addEventListener("click", () => $("request-form").scrollIntoView({ behavior: "smooth" }));
  $("cta-strip").addEventListener("click", () => $("engine-panel").scrollIntoView({ behavior: "smooth" }));
  $("btn-standard").disabled = true; $("btn-pro").disabled = true;

  async function restoreAccount() {
    if (!isInTelegram) return;
    try {
      const response = await fetch("/api/me", { headers: { "X-Init-Data": initData } });
      const data = await response.json();
      if (response.ok && data.ok && data.license) {
        applyLicenseBar({ email: data.email || "", tier: data.license.tier, expiresAt: data.license.expiresAt });
        $("form-fields").classList.add("hidden");
        $("existing-license-panel").classList.remove("hidden");
        $("el-token").value = data.license.token;
        text("el-expires", new Date(data.license.expiresAt).toISOString().slice(0, 10));
      }
    } catch {}
  }
  $("el-reveal-btn").addEventListener("click", () => { $("el-token").style.filter = "none"; $("el-reveal-btn").classList.add("hidden"); $("el-copy-btn").classList.remove("hidden"); });
  $("el-copy-btn").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("el-token").value); } catch {} text("el-copy-btn", "COPIED"); });

  setInterval(() => { text("clock", new Date().toTimeString().slice(0, 8)); }, 1000);
  void restoreAccount();
  validate();
})();