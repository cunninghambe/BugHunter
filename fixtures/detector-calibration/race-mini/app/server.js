#!/usr/bin/env node
// race-mini — fixture for V56.4.13 (Bucket F) race-condition kinds:
// race_condition_double_submit, race_condition_click_navigate,
// race_condition_optimistic_revert, race_condition_interleaved_mutations,
// race_condition_cross_tab. Each route synthesises (plan, observations) and
// pushes via window.__bh.pushRacePlan; harness dispatches through production
// race-detectors.

'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9663;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const obs = (overrides) => Object.assign({
  offsetMs: 0, url: 'http://x', consoleErrorCount: 0,
  targetSelectorHash: 'h0', toastVisible: false,
  targetSelectorState: 'pre',
}, overrides);

const ROUTES = {
  // ---- double_submit fires ----
  '/double-submit-fires': html('double-submit fires', `
    window.__bh.pushRacePlan({
      variantKind: 'double_submit',
      plan: { variant: { kind: 'double_submit', gapMs: 50 }, toolId: 'create-post', toolPath: '/api/posts', raceNonce: 'abc' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 200 }))},
        ${JSON.stringify(obs({ offsetMs: 50, targetSelectorState: 'pre', responseStatus: 200 }))},
        ${JSON.stringify(obs({ offsetMs: 1000, targetSelectorState: 'final' }))},
      ],
    });
  `),

  // ---- double_submit silent (only one response) ----
  '/double-submit-silent': html('double-submit silent', `
    window.__bh.pushRacePlan({
      variantKind: 'double_submit',
      plan: { variant: { kind: 'double_submit', gapMs: 50 }, toolId: 'create-post', toolPath: '/api/posts', raceNonce: 'abc' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 200 }))},
        ${JSON.stringify(obs({ offsetMs: 1000, targetSelectorState: 'final' }))},
      ],
    });
  `),

  // ---- click_then_navigate fires (stale post-nav) ----
  '/click-navigate-fires': html('click-navigate fires', `
    window.__bh.pushRacePlan({
      variantKind: 'click_then_navigate',
      plan: { variant: { kind: 'click_then_navigate', targetRoute: '/dashboard', preFireDelayMs: 0 }, toolId: 'update-post', toolPath: '/api/posts/1', pageRoute: '/posts/edit' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 0, targetSelectorState: 'pre' }))},
        ${JSON.stringify(obs({ offsetMs: 2000, targetSelectorState: 'pre', consoleErrorCount: 0, toastVisible: false }))},
      ],
    });
  `),

  // ---- click_then_navigate silent (final state shown after success) ----
  '/click-navigate-silent': html('click-navigate silent', `
    window.__bh.pushRacePlan({
      variantKind: 'click_then_navigate',
      plan: { variant: { kind: 'click_then_navigate', targetRoute: '/dashboard', preFireDelayMs: 0 }, toolId: 'update-post', toolPath: '/api/posts/1', pageRoute: '/posts/edit' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 0, targetSelectorState: 'pre', responseStatus: 200 }))},
        ${JSON.stringify(obs({ offsetMs: 2000, targetSelectorState: 'final', consoleErrorCount: 0, toastVisible: false }))},
      ],
    });
  `),

  // ---- optimistic_revert fires (no revert, optimistic state persists) ----
  '/optimistic-revert-fires': html('optimistic-revert fires', `
    window.__bh.pushRacePlan({
      variantKind: 'optimistic_revert',
      plan: { variant: { kind: 'optimistic_revert', forcedStatus: 500, forcedBody: '{"error":"forced"}' }, toolId: 'like-post', toolPath: '/api/posts/1/like', pageRoute: '/posts/1' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 300, targetSelectorState: 'optimistic' }))},
        ${JSON.stringify(obs({ offsetMs: 5000, targetSelectorState: 'optimistic', consoleErrorCount: 0, toastVisible: false }))},
      ],
    });
  `),

  // ---- optimistic_revert silent (UI reverted) ----
  '/optimistic-revert-silent': html('optimistic-revert silent', `
    window.__bh.pushRacePlan({
      variantKind: 'optimistic_revert',
      plan: { variant: { kind: 'optimistic_revert', forcedStatus: 500, forcedBody: '{"error":"forced"}' }, toolId: 'like-post', toolPath: '/api/posts/1/like', pageRoute: '/posts/1' },
      observations: [
        ${JSON.stringify(obs({ offsetMs: 300, targetSelectorState: 'optimistic' }))},
        ${JSON.stringify(obs({ offsetMs: 5000, targetSelectorState: 'reverted' }))},
      ],
    });
  `),

  // ---- interleaved_mutations fires (≥2 of 3 runs diverge) ----
  '/interleaved-fires': html('interleaved fires', `
    window.__bh.pushRacePlan({
      variantKind: 'interleaved_mutations',
      plan: { variant: { kind: 'interleaved_mutations', siblingActionId: 'patch-post', gapMs: 0, consensusRuns: 3 }, toolId: 'update-post', toolPath: '/api/posts/1', siblingToolId: 'patch-post', pageRoute: '/posts/edit' },
      runObservations: [
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' }))}],
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' }))}],
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-B' }))}],
      ],
    });
  `),

  // ---- interleaved_mutations silent (all runs agree) ----
  '/interleaved-silent': html('interleaved silent', `
    window.__bh.pushRacePlan({
      variantKind: 'interleaved_mutations',
      plan: { variant: { kind: 'interleaved_mutations', siblingActionId: 'patch-post', gapMs: 0, consensusRuns: 3 }, toolId: 'update-post', toolPath: '/api/posts/1', siblingToolId: 'patch-post', pageRoute: '/posts/edit' },
      runObservations: [
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' }))}],
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' }))}],
        [${JSON.stringify(obs({ offsetMs: 1000, targetSelectorHash: 'hash-A' }))}],
      ],
    });
  `),

  // ---- cross_tab fires (tab1 != tab2) ----
  '/cross-tab-fires': html('cross-tab fires', `
    window.__bh.pushRacePlan({
      variantKind: 'cross_tab',
      plan: { variant: { kind: 'cross_tab', settleMs: 5000 }, toolId: 'update-counter', toolPath: '/api/counter', pageRoute: '/counter' },
      tab1Obs: [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-tab1', targetSelectorState: 'final' }))}],
      tab2Obs: [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-tab2', targetSelectorState: 'final' }))}],
    });
  `),

  // ---- cross_tab silent (tabs match) ----
  '/cross-tab-silent': html('cross-tab silent', `
    window.__bh.pushRacePlan({
      variantKind: 'cross_tab',
      plan: { variant: { kind: 'cross_tab', settleMs: 5000 }, toolId: 'update-counter', toolPath: '/api/counter', pageRoute: '/counter' },
      tab1Obs: [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' }))}],
      tab2Obs: [${JSON.stringify(obs({ offsetMs: 5000, targetSelectorHash: 'hash-same', targetSelectorState: 'final' }))}],
    });
  `),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`race-mini ready on port ${PORT}\n`);
});
