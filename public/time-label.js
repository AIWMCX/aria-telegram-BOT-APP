(function (root) {
  "use strict";
  // Pure helpers, no DOM access. Loaded before app.js; also importable by tests (see test/time-label.ts).
  var STALE_AFTER_MS = 5 * 60 * 1000;

  function timeAgo(iso, now) {
    if (!iso) return "never";
    var ms = (now === undefined ? Date.now() : now) - new Date(iso).getTime();
    if (!isFinite(ms)) return "unknown";
    if (ms < 0) return "just now";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h " + (m % 60) + "m ago";
    var d = Math.floor(h / 24);
    return d + "d " + (h % 24) + "h ago";
  }

  function validMs(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    return isFinite(t) ? t : null;
  }

  // Stale = strictly older than 5 minutes. A missing timestamp is not stale (callers handle "no snapshot").
  function isStale(iso, now) {
    var t = validMs(iso);
    if (t === null) return false;
    return (now === undefined ? Date.now() : now) - t > STALE_AFTER_MS;
  }

  function staleLabel(iso) {
    return "STALE · last update " + new Date(iso).toLocaleString();
  }

  // Market-data freshness is based on the snapshot receivedAt ONLY. The device lastSeenAt is a heartbeat and
  // never makes market data look fresh. Only a "live" data mode can be relabelled; other modes already say
  // they are not real market data.
  function dataLabel(baseLabel, dataMode, snapshotAt, deviceAt, now) {
    if (dataMode !== "live") return baseLabel;
    if (validMs(snapshotAt) !== null) return isStale(snapshotAt, now) ? staleLabel(snapshotAt) : baseLabel;
    if (validMs(deviceAt) !== null && !isStale(deviceAt, now)) return "ENGINE ONLINE · NO MARKET SNAPSHOT";
    return "NO DATA YET";
  }

  function snapshotText(receivedAt, now) {
    var base = "SNAPSHOT " + timeAgo(receivedAt, now);
    return isStale(receivedAt, now) ? base + " · STALE" : base;
  }

  var api = { STALE_AFTER_MS: STALE_AFTER_MS, timeAgo: timeAgo, isStale: isStale, staleLabel: staleLabel, dataLabel: dataLabel, snapshotText: snapshotText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ARIATimeLabel = api;
})(typeof window !== "undefined" ? window : globalThis);
