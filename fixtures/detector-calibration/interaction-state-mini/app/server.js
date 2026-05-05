#!/usr/bin/env node
// interaction-state-mini — fixture for 4 V56.4.10 (Bucket E) kinds:
//   keyboard_trap, focus_lost_after_action,
//   shadow_dom_a11y_violation, visibility_change_state_loss
//
// Each route synthesises the production-classifier input via the bootstrap
// helpers (setKeyboardTrap / setFocusAfterAction / pushShadowAxe /
// setVisibilityChangeStateLoss). The harness dispatches through production
// classifyA11yBaseline + the harness-side shadow / visibility classifiers.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9693;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() {
  if (!window.__bh) return;
  ${injectScript}
}, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- keyboard_trap ----
  '/keyboard-trap': html('keyboard trap', `
    window.__bh.setKeyboardTrap({
      trapped: true,
      selectorClass: '#trap-target',
      pressCount: 8,
      observedFocusChain: ['#trap-target', '#trap-target', '#trap-target'],
    });
  `),
  '/keyboard-clean': html('keyboard clean', `
    window.__bh.setKeyboardTrap({ trapped: false });
  `),
  '/keyboard-not-probed': html('keyboard not probed', `/* nothing pushed — silent */`),

  // ---- focus_lost_after_action ----
  '/focus-lost': html('focus lost', `
    window.__bh.setFocusAfterAction({
      lost: true,
      activeElementTag: 'BODY',
      triggeringSelector: '#delete-btn',
    });
  `),
  '/focus-preserved': html('focus preserved', `
    window.__bh.setFocusAfterAction({ lost: false, activeElementTag: 'BUTTON' });
  `),
  '/focus-not-probed': html('focus not probed', `/* nothing pushed — silent */`),

  // ---- shadow_dom_a11y_violation ----
  '/shadow-violation-critical': html('shadow critical', `
    window.__bh.pushShadowAxe({
      hostSelector: 'my-card',
      hostTagName: 'my-card',
      ruleId: 'image-alt',
      impact: 'critical',
      description: 'Image inside shadow root missing alt',
    });
  `),
  '/shadow-violation-serious': html('shadow serious', `
    window.__bh.pushShadowAxe({
      hostSelector: 'tab-list',
      hostTagName: 'tab-list',
      ruleId: 'aria-required-children',
      impact: 'serious',
    });
  `),
  '/shadow-moderate-skip': html('shadow moderate skip', `
    window.__bh.pushShadowAxe({
      hostSelector: 'spacer-el',
      hostTagName: 'spacer-el',
      ruleId: 'landmark-one-main',
      impact: 'moderate',
    });
  `),
  '/shadow-clean': html('shadow clean', `/* no shadow violations pushed */`),

  // ---- visibility_change_state_loss ----
  '/visibility-state-lost': html('visibility state lost', `
    window.__bh.setVisibilityChangeStateLoss({
      lifecycleEvent: 'visibilitychange',
      proof: 'state_lost_post_lifecycle',
      toolPath: '/api/cart/add',
      evidence: 'pre=ab12cd optimistic=optimistic final=ab12cd',
    });
  `),
  '/visibility-rollback': html('visibility rollback', `
    window.__bh.setVisibilityChangeStateLoss({
      lifecycleEvent: 'pagehide',
      proof: 'rollback_post_lifecycle',
      toolPath: '/api/checkout',
      evidence: 'Response arrived (state=final at 100ms) but reverted to pre-state after pagehide',
    });
  `),
  '/visibility-clean': html('visibility clean', `/* no visibility-change payload */`),

  // negative for ALL kinds
  '/clean': html('clean', `/* nothing */`),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const body = ROUTES[pathname];
  if (body !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`interaction-state-mini ready on port ${PORT}\n`);
});
