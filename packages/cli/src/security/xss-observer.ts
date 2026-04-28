// XSS DOM canary observer scripts (v0.7).
// Pure constants — no IO, no side effects in this module.
// Injected into the browser page via scope.evaluate().

/**
 * Installs a window-level XSS canary tracker. Idempotent — safe to call on the
 * same page multiple times (e.g. when the same page runs for owner + anon).
 *
 * After injection:
 *   window.__bh_xss  — Map<nonce, { fired: boolean; sink: string }>
 *
 * Call XSS_OBSERVER_DRAIN_SCRIPT to read and clear the map.
 */
export const XSS_OBSERVER_START_SCRIPT: string = `(function(){
  if (window.__bh_xss_installed) return;
  window.__bh_xss_installed = true;
  window.__bh_xss = new Map();
  var _bh_interval;

  function sweep() {
    for (var k of Object.keys(window)) {
      if (k.startsWith('__bh_xss_') && k.length > 9) {
        var nonce = k.slice(9);
        if (!window.__bh_xss.has(nonce)) {
          window.__bh_xss.set(nonce, { fired: true, sink: 'window_assign' });
        }
      }
    }
  }

  _bh_interval = setInterval(sweep, 100);

  var obs = new MutationObserver(function(muts) {
    for (var m of muts) {
      for (var node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        var html = node.outerHTML || '';
        var match = html.match(/__bh_xss_([a-f0-9]{16})/);
        if (match) {
          var nonce = match[1];
          if (!window.__bh_xss.has(nonce)) {
            window.__bh_xss.set(nonce, { fired: true, sink: 'dom_inserted' });
          }
        }
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('unload', function() {
    clearInterval(_bh_interval);
    obs.disconnect();
  });
})();`;

/**
 * Reads all fired canary entries from window.__bh_xss, clears the map,
 * and clears the polling interval. Returns an array of
 * { nonce: string; fired: boolean; sink: string }.
 */
export const XSS_OBSERVER_DRAIN_SCRIPT: string = `(function(){
  var out = [];
  if (window.__bh_xss instanceof Map) {
    for (var entry of window.__bh_xss) {
      out.push({ nonce: entry[0], fired: entry[1].fired, sink: entry[1].sink });
    }
    window.__bh_xss.clear();
  }
  return out;
})()`;
