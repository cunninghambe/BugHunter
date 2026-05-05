#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9533;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- agent_response_hallucinated ----
  '/agent-hallucinated-fires': html('agent hallucinated fires', `
    window.__bh.pushSentinelEvent({
      kind: 'agent_response_hallucinated', severity: 'major',
      rootCause: 'Agent cited nonexistent endpoint /api/v3/magic — not present in sitemap or surface map',
    });
  `),
  '/agent-hallucinated-silent': html('agent hallucinated silent', '/* no sentinel — response grounded */'),

  // ---- agent_action_timeout ----
  '/agent-timeout-fires': html('agent action timeout fires', `
    window.__bh.pushSentinelEvent({
      kind: 'agent_action_timeout', severity: 'major',
      rootCause: 'Agent tool call create_order exceeded 30s budget (no response after 30042ms)',
    });
  `),
  '/agent-timeout-silent': html('agent action timeout silent', '/* no sentinel — action completed within budget */'),

  // ---- streaming_response_truncated ----
  '/streaming-truncated-fires': html('streaming truncated fires', `
    window.__bh.pushSentinelEvent({
      kind: 'streaming_response_truncated', severity: 'minor',
      rootCause: 'SSE stream at /api/chat/stream closed mid-sentence: "The answer is" (no [DONE] token received)',
    });
  `),
  '/streaming-truncated-silent': html('streaming truncated silent', '/* no sentinel — stream completed with [DONE] */'),

  // ---- tool_call_failure_unhandled ----
  '/tool-call-failure-fires': html('tool call failure fires', `
    window.__bh.pushSentinelEvent({
      kind: 'tool_call_failure_unhandled', severity: 'major',
      rootCause: 'Tool call search_knowledge_base returned error "index_not_found" with no retry or user-visible fallback',
    });
  `),
  '/tool-call-failure-silent': html('tool call failure silent', '/* no sentinel — failure handled with retry */'),

  // ---- agent_cost_per_turn_high ----
  '/agent-cost-fires': html('agent cost fires', `
    window.__bh.pushSentinelEvent({
      kind: 'agent_cost_per_turn_high', severity: 'info',
      rootCause: 'Agent turn cost $0.43 (threshold: $0.10): 8200 input tokens + 1400 output tokens on model claude-opus',
    });
  `),
  '/agent-cost-silent': html('agent cost silent', '/* no sentinel — cost within threshold */'),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`agent-runner-mini ready on port ${PORT}\n`));
