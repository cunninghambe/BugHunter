#!/usr/bin/env node
// nav-state-mini — fixture for 5 nav-state kinds (V56.4.9 / Bucket D).
// Each route's HTML synthesises NavClassifyInput / BackAfterFormFillInput shapes
// and pushes them via window.__bh.pushNavInput / setBackAfterFormFill. The
// browser-harness classifier dispatches each input through the production
// classifyNavTransition / classifyBackAfterFormFill function — same code paths,
// fixture-controlled state.

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9703;

function html(label, navInputsScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() {
  if (!window.__bh) return;
  ${navInputsScript}
}, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- nav_refresh_double_mutation ----
  // refresh transition with still-pending mutation that doubled in post.
  '/refresh-double-mutation': html('refresh double mutation', `
    window.__bh.pushNavInput({
      transition: { kind: 'refresh' },
      pre: { url: '/cart', title: 'Cart', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: {
        url: '/cart',
        domSignature: 'sig:mid',
        inFlightRequests: [{ method: 'POST', path: '/api/cart/checkout', startedAtMs: 100 }],
        mutationCompletionSignal: 'still-pending',
      },
      post: {
        url: '/cart', title: 'Cart', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:post',
        networkRequests: [
          { method: 'POST', path: '/api/cart/checkout', status: 200, duration: 50 },
        ],
      },
      pageRoute: '/refresh-double-mutation',
    });
  `),

  // ---- nav_state_corruption (refresh erased mid-action) ----
  '/refresh-erased': html('refresh erased state', `
    window.__bh.pushNavInput({
      transition: { kind: 'refresh' },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: {
        url: '/page',
        domSignature: 'sig:mid',
        inFlightRequests: [],
        mutationCompletionSignal: 'no-network',
      },
      post: {
        url: '/page', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:pre',  // post matches pre, not interim
        networkRequests: [],
      },
      pageRoute: '/refresh-erased',
    });
  `),

  // ---- nav_resubmit_on_back ----
  // back triggers resubmit of POST request.
  '/back-resubmit': html('back resubmit', `
    window.__bh.pushNavInput({
      transition: { kind: 'back' },
      pre: { url: '/form', title: 'Form', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: {
        url: '/form/result',
        domSignature: 'sig:mid',
        inFlightRequests: [{ method: 'POST', path: '/api/submit', startedAtMs: 100 }],
        mutationCompletionSignal: 'response-200ish',
      },
      post: {
        url: '/form', title: 'Form', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:post',
        networkRequests: [
          { method: 'POST', path: '/api/submit', status: 200, duration: 50 },
        ],
      },
      pageRoute: '/back-resubmit',
    });
  `),

  // ---- nav_state_corruption (back produces third state) ----
  '/back-third-state': html('back third state', `
    window.__bh.pushNavInput({
      transition: { kind: 'back' },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: {
        url: '/page',
        domSignature: 'sig:interim',
        inFlightRequests: [],
        mutationCompletionSignal: 'no-network',
      },
      post: {
        url: '/page', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:third',  // neither pre nor interim
        networkRequests: [],
      },
      pageRoute: '/back-third-state',
    });
  `),

  // ---- nav_state_corruption (history_corrupt: pushState URL mismatch) ----
  '/history-corrupt': html('history corrupt', `
    window.__bh.pushNavInput({
      transition: { kind: 'history_corrupt', pushStates: [{ state: {}, url: '/page/expected' }] },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: { url: '/page', domSignature: 'sig:mid', inFlightRequests: [], mutationCompletionSignal: 'no-network' },
      post: {
        url: '/page/wrong', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:post',
        networkRequests: [],
      },
      pageRoute: '/history-corrupt',
    });
  `),

  // ---- nav_state_corruption (deep_link_no_auth) ----
  '/deep-link-no-auth': html('deep link no auth', `
    window.__bh.pushNavInput({
      transition: { kind: 'deep_link_no_auth', capturedUrl: '/admin/users' },
      pre: { url: '/admin/users', title: 'Admin', consoleErrorCount: 0 },
      interim: { url: '/admin/users', domSignature: 'sig:mid', inFlightRequests: [], mutationCompletionSignal: 'no-network' },
      post: {
        url: '/admin/users', title: 'Admin', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:rendered',  // not auth/login marker
        networkRequests: [],
      },
      pageRoute: '/deep-link-no-auth',
    });
  `),

  // ---- nav_form_state_lost ----
  '/form-state-lost': html('form state lost', `
    window.__bh.setBackAfterFormFill({
      pageRoute: '/form-state-lost',
      pre: { url: '/form', title: 'Form', consoleErrorCount: 0 },
      interim: {
        url: '/form',
        domSignature: 'sig',
        inFlightRequests: [],
        formSnapshot: { name: 'Alice', email: 'alice@example.com' },
        mutationCompletionSignal: 'no-network',
      },
      post: {
        url: '/form', title: 'Form', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        networkRequests: [],
        formSnapshot: {},  // empty — fields lost
      },
      formSignature: 'name|email',
    });
  `),

  // ---- nav_form_state_stale ----
  '/form-state-stale': html('form state stale', `
    window.__bh.setBackAfterFormFill({
      pageRoute: '/form-state-stale',
      pre: { url: '/form', title: 'Form', consoleErrorCount: 0 },
      interim: {
        url: '/form',
        domSignature: 'sig',
        inFlightRequests: [],
        formSnapshot: { name: 'Alice', email: 'alice@example.com' },
        mutationCompletionSignal: 'no-network',
      },
      post: {
        url: '/form', title: 'Form', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        networkRequests: [],
        formSnapshot: { name: 'Bob', email: 'alice@example.com' },  // name diverged
      },
      formSignature: 'name|email',
    });
  `),

  // ---- Negative routes ----
  // /clean — no nav input pushed; all nav-kinds silent.
  '/clean': html('clean', `/* nothing */`),

  // /refresh-clean — refresh transition, no double-mutation, post matches interim (state preserved)
  '/refresh-clean': html('refresh clean', `
    window.__bh.pushNavInput({
      transition: { kind: 'refresh' },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: { url: '/page', domSignature: 'sig:mid', inFlightRequests: [], mutationCompletionSignal: 'no-network' },
      post: {
        url: '/page', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:mid',  // post matches interim — state preserved
        networkRequests: [],
      },
      pageRoute: '/refresh-clean',
    });
  `),

  // /back-clean — back transition, no resubmit, post matches pre (clean back)
  '/back-clean': html('back clean', `
    window.__bh.pushNavInput({
      transition: { kind: 'back' },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: { url: '/page', domSignature: 'sig:mid', inFlightRequests: [], mutationCompletionSignal: 'no-network' },
      post: {
        url: '/page', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:pre',
        networkRequests: [],
      },
      pageRoute: '/back-clean',
    });
  `),

  // /modal-close-skip — modal-close guard: interim domSignature starts with "modal:" → silent
  '/modal-close-skip': html('modal close skip', `
    window.__bh.pushNavInput({
      transition: { kind: 'back' },
      pre: { url: '/page', title: 'Page', consoleErrorCount: 0, domSignature: 'sig:pre' },
      interim: { url: '/page', domSignature: 'modal:open', inFlightRequests: [], mutationCompletionSignal: 'no-network' },
      post: {
        url: '/page', title: 'Page', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        domSignature: 'sig:third',
        networkRequests: [],
      },
      pageRoute: '/modal-close-skip',
    });
  `),

  // /form-state-clean — back-after-form-fill with no loss/stale (post matches interim)
  '/form-state-clean': html('form state clean', `
    window.__bh.setBackAfterFormFill({
      pageRoute: '/form-state-clean',
      pre: { url: '/form', title: 'Form', consoleErrorCount: 0 },
      interim: {
        url: '/form',
        domSignature: 'sig',
        inFlightRequests: [],
        formSnapshot: { name: 'Alice' },
        mutationCompletionSignal: 'no-network',
      },
      post: {
        url: '/form', title: 'Form', consoleErrors: [], domErrorTextDetected: false, mutationObserverWindowMs: 1500,
        networkRequests: [],
        formSnapshot: { name: 'Alice' },
      },
      formSignature: 'name',
    });
  `),
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
  process.stdout.write(`nav-state-mini ready on port ${PORT}\n`);
});
