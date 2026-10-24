(function (root) {
  "use strict";
  // Pure helpers, no DOM access. Loaded before app.js; also importable by tests (see test/time-label.ts).
  var STALE_AFTER_MS = 5 * 60 * 1000;

  function ageMs(iso, now) {
    if (!iso) return NaN;
    var t = new Date(iso).getTime();
    return (now === undefined ? Date.now() : now) - t;
  }

  function timeAgo(iso, now) {
    if (!iso) return "never";
    var ms = ageMs(iso, now);
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

  // Most recent valid timestamp among the inputs, as ms; null when none is usable.
  function latestMs(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      var t = new Date(list[i]).getTime();
      if (isFinite(t) && (best === null || t > best)) best = t;
    }
    return best;
  }

  // Stale = the freshest known update is older than 5 minutes. No known update means "not applicable", not stale.
  function isStale(list, now) {
    var latest = latestMs(list);
    if (latest === null) return false;
    return (now === undefined ? Date.now() : now) - latest > STALE_AFTER_MS;
  }

  function staleLabel(list) {
    var latest = latestMs(list);
    return "STALE · last update " + new Date(latest).toLocaleString();
  }

  // Only a "live" data mode can be stale; every other mode already says it is not real market data.
  function dataLabel(baseLabel, dataMode, list, now) {
    if (dataMode === "live" && isStale(list, now)) return staleLabel(list);
    return baseLabel;
  }

  function snapshotText(receivedAt, now) {
    var base = "SNAPSHOT " + timeAgo(receivedAt, now);
    return isStale([receivedAt], now) ? base + " · STALE" : base;
  }

  var api = { STALE_AFTER_MS: STALE_AFTER_MS, timeAgo: timeAgo, isStale: isStale, staleLabel: staleLabel, dataLabel: dataLabel, snapshotText: snapshotText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ARIATimeLabel = api;
})(typeof window !== "undefined" ? window : globalThis);
