(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); try { tg.setHeaderColor("#0a0c0d"); tg.setBackgroundColor("#0a0c0d"); } catch {} }
  const initData = (tg && tg.initData) || "";
  const isInTelegram = Boolean(initData);
  const realityLabels = () => Array.from(document.querySelectorAll("[data-reality-label]"));
  const SAFE_REALITY = Object.freeze({ environment: "production", network: "offline", dataMode: "unavailable", executionMode: "disabled", controlState: "stopped", paymentsEnabled: false });
  const VALID = {
    environment: new Set(["production", "staging", "development"]), network: new Set(["offline", "solana-devnet", "solana-mainnet"]),
    dataMode: new Set(["unavailable", "simulated", "live"]), executionMode: new Set(["disabled", "paper", "devnet", "mainnet"]), controlState: new Set(["stopped", "starting", "running", "stopping"]),
  };
  const NETWORK_LABEL = { offline: "OFFLINE", "solana-devnet": "SOLANA DEVNET", "solana-mainnet": "SOLANA MAINNET" };
  const DATA_LABEL = { unavailable: "UNAVAILABLE", simulated: "SIMULATED", live: "LIVE DATA" };
  const EXECUTION_LABEL = { disabled: "EXECUTION DISABLED", paper: "PAPER EXECUTION", devnet: "DEVNET EXECUTION", mainnet: "MAINNET EXECUTION" };
  function validateRealityPayload(payload) {
    if (!payload || payload.ok !== true || !payload.reality || typeof payload.reality !== "object") return null;
    const r = payload.reality;
    if (!["environment", "network", "dataMode", "executionMode", "controlState"].every((key) => VALID[key].has(r[key])) || typeof r.paymentsEnabled !== "boolean") return null;
    return Object.freeze({ environment: r.environment, network: r.network, dataMode: r.dataMode, executionMode: r.executionMode, controlState: r.controlState, paymentsEnabled: r.paymentsEnabled });
  }
  function renderReality(reality) {
    $("data-mode").textContent = DATA_LABEL[reality.dataMode]; $("network-mode").textContent = NETWORK_LABEL[reality.network];
    $("execution-mode").textContent = EXECUTION_LABEL[reality.executionMode]; $("control-state").textContent = reality.controlState.toUpperCase();
    const disclosure = reality.dataMode === "simulated" ? "SIMULATED - NO REAL FUNDS" : reality.dataMode === "live" ? "LIVE DATA" : "UNAVAILABLE - NO REAL FUNDS";
    $("reality-banner").textContent = reality.dataMode === "live" ? `${disclosure} - ${EXECUTION_LABEL[reality.executionMode]} - ${NETWORK_LABEL[reality.network]}` : `${disclosure} - ${EXECUTION_LABEL[reality.executionMode]}`;
    for (const label of realityLabels()) label.textContent = disclosure;
  }
  function clearGeneratedData() {
    for (const id of ["s-detected", "s-traded", "s-latency", "s-pnl", "f-detected", "f-tooOld", "f-safety", "f-social", "f-queued", "f-bought", "f-sold"]) if ($(id)) $(id).textContent = "—";
    $("s-detected-rate").textContent = "unavailable"; $("s-blocked").textContent = "unavailable"; $("s-pnl-pct").textContent = "unavailable"; $("uptime").textContent = "UNAVAILABLE - NO REAL FUNDS";
    $("feed").textContent = ""; $("feed-count").textContent = "0 events"; $("pos-body").textContent = "";
    const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 5; td.textContent = "position data unavailable"; tr.append(td); $("pos-body").append(tr); $("pos-count").textContent = "—";
  }
  async function loadReality() {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000);
    try { const response = await fetch("/api/product-reality", { signal: controller.signal, headers: { Accept: "application/json" } }); if (!response.ok) throw new Error("reality unavailable"); const reality = validateRealityPayload(await response.json()); if (!reality) throw new Error("reality malformed"); renderReality(reality); clearGeneratedData(); }
    catch { renderReality(SAFE_REALITY); clearGeneratedData(); }
    finally { clearTimeout(timer); }
  }
  renderReality(SAFE_REALITY); clearGeneratedData(); void loadReality();

  function engineText(id, value) { const el = $(id); if (el) el.textContent = value; }
  function engineRequest(path, options = {}) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000); const headers = Object.assign({ Accept: "application/json", "X-Init-Data": initData }, options.headers || {}); return fetch(path, Object.assign({}, options, { headers, signal: controller.signal })).finally(() => clearTimeout(timer)); }
  function renderEngineDisconnected(message = "pair a local engine to begin") { engineText("engine-connection", "DISCONNECTED"); engineText("engine-status", message); engineText("engine-network", "—"); engineText("engine-address", "—"); engineText("engine-balance", "—"); engineText("engine-events", ""); $("engine-start-btn").disabled = true; $("engine-stop-btn").disabled = true; }
  function renderEngineDashboard(dashboard) {
    const state = dashboard && dashboard.state; if (!state) { renderEngineDisconnected("no paired engine state"); return; }
    const fresh = state.lastHeartbeatAt && Date.now() - new Date(state.lastHeartbeatAt).getTime() < 15_000;
    engineText("engine-connection", fresh ? "CONNECTED" : "DISCONNECTED"); engineText("engine-status", state.status === "paper_running" ? "PAPER RUNNING — NO REAL ORDERS" : String(state.status).toUpperCase());
    engineText("engine-network", state.network || "—"); engineText("engine-address", state.publicAddress || "—"); engineText("engine-balance", state.balanceLamports ? `${state.balanceLamports} lamports` : "—");
    $("engine-start-btn").disabled = !fresh || state.status === "paper_running" || state.licenseStatus !== "valid"; $("engine-stop-btn").disabled = !fresh || state.status !== "paper_running";
    const events = $("engine-events"); events.textContent = ""; for (const event of Array.isArray(dashboard.events) ? dashboard.events : []) { const row = document.createElement("div"); row.className = "ev"; const text = document.createElement("span"); text.className = "m"; text.textContent = `${event.kind || "event"}: ${event.message || ""} — PAPER — NO REAL ORDERS`; row.append(text); events.append(row); }
  }
  async function refreshEngine() { if (!isInTelegram) { renderEngineDisconnected("open this control center inside Telegram"); return; } try { const response = await engineRequest("/api/engine/dashboard"); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "engine unavailable"); renderEngineDashboard(data.dashboard); } catch { renderEngineDisconnected("engine unavailable"); } }
  async function pairEngine() { if (!isInTelegram) { renderEngineDisconnected("open this control center inside Telegram"); return; } try { const response = await engineRequest("/api/engine/pairing", { method: "POST" }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || "pairing unavailable"); engineText("engine-pairing", `One-time code: ${data.pairingCode} · expires ${new Date(data.expiresAt).toLocaleTimeString()}`); } catch (error) { engineText("engine-pairing", error.message || "pairing unavailable"); } }
  async function commandEngine(type) { const devices = await (await engineRequest("/api/engine/devices")).json(); const device = (devices.devices || []).find((item) => item.status === "active"); if (!device) throw new Error("no active paired engine"); const randomId = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`; const command = { id: randomId, type, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), payload: null }; const response = await engineRequest("/api/engine/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.id, command }) }); if (!response.ok) throw new Error("engine command rejected"); setTimeout(refreshEngine, 500); }
  $("engine-pair-btn").addEventListener("click", pairEngine); $("engine-start-btn").addEventListener("click", () => commandEngine("start_paper").catch((error) => renderEngineDisconnected(error.message))); $("engine-stop-btn").addEventListener("click", () => commandEngine("stop").catch((error) => renderEngineDisconnected(error.message))); renderEngineDisconnected(); if (isInTelegram) { void refreshEngine(); setInterval(refreshEngine, 5000); }

  const TIER_LIMITS = { trial: { label: "FREE", buy: "0.02 SOL", pos: "5", total: "0.1 SOL" }, standard: { label: "STANDARD", buy: "0.01 SOL", pos: "5", total: "0.05 SOL" }, pro: { label: "PRO", buy: "0.05 SOL", pos: "10", total: "0.5 SOL" } };
  function applyLicenseBar({ email, tier, expiresAt }) { const cfg = TIER_LIMITS[tier] || TIER_LIMITS.trial; $("lic-sub").textContent = email; $("lic-tier").textContent = cfg.label; $("lic-days").textContent = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)) + "d"; $("lic-buy").textContent = cfg.buy; $("lic-pos").textContent = cfg.pos; $("lic-total").textContent = cfg.total; }
  const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function values() { return { name: $("i-name").value.trim(), email: $("i-email").value.trim(), wallet: $("i-wallet").value.trim(), interest: $("i-interest").value.trim(), website: $("i-website").value.trim() }; }
  function validate() { const value = values(); const valid = value.name.length >= 2 && EMAIL_RE.test(value.email) && SOLANA_RE.test(value.wallet); $("submit-btn").disabled = !valid; return { valid, ...value }; }
  async function submitTrial() { const value = validate(); if (!value.valid || !isInTelegram) { $("status").textContent = !isInTelegram ? "Open this control center inside Telegram to submit." : "Complete the required fields."; return; } const response = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData, ...value }) }); const data = await response.json(); if (!response.ok || !data.ok) { $("status").textContent = data.error || "Submission failed"; return; } $("form-fields").classList.add("hidden"); $("status").textContent = `Free license issued (${data.licenseId}).`; applyLicenseBar({ email: value.email, tier: data.tier || "trial", expiresAt: data.expiresAt }); }
  $("submit-btn").addEventListener("click", submitTrial); ["name", "email", "wallet", "interest"].forEach((id) => $("i-" + id).addEventListener("input", validate)); $("btn-trial").addEventListener("click", () => $("request-form").scrollIntoView({ behavior: "smooth" })); $("cta-strip").addEventListener("click", () => $("pricing").scrollIntoView({ behavior: "smooth" })); $("btn-standard").disabled = true; $("btn-pro").disabled = true;
  async function restoreAccount() { if (!isInTelegram) return; try { const response = await fetch("/api/me", { headers: { "X-Init-Data": initData } }); const data = await response.json(); if (response.ok && data.ok && data.license) { applyLicenseBar({ email: data.email || "", tier: data.license.tier, expiresAt: data.license.expiresAt }); $("form-fields").classList.add("hidden"); $("existing-license-panel").classList.remove("hidden"); $("el-token").value = data.license.token; $("el-expires").textContent = new Date(data.license.expiresAt).toISOString().slice(0, 10); } } catch {} }
  $("el-reveal-btn").addEventListener("click", () => { $("el-token").style.filter = "none"; $("el-reveal-btn").classList.add("hidden"); $("el-copy-btn").classList.remove("hidden"); }); $("el-copy-btn").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("el-token").value); } catch {} $("el-copy-btn").textContent = "COPIED"; });
  setInterval(() => { $("clock").textContent = new Date().toTimeString().slice(0, 8); }, 1000); void restoreAccount(); validate();
})();
