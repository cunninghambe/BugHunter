#!/usr/bin/env node
'use strict';
const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9523;

function html(label, injectScript) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>setTimeout(function() { if (!window.__bh) return; ${injectScript} }, 100);</script>
</head><body><h1>${label}</h1></body></html>`;
}

const ROUTES = {
  // ---- drag_drop_failure ----
  '/drag-drop-fires': html('drag drop fires', `
    window.__bh.pushSentinelEvent({
      kind: 'drag_drop_failure', severity: 'major',
      rootCause: 'Drag of text/plain payload to #drop-zone produced no drop event — dragover.preventDefault not called',
    });
  `),
  '/drag-drop-silent': html('drag drop silent', '/* no sentinel — drag succeeded */'),

  // ---- paste_handler_failure ----
  '/paste-handler-fires': html('paste handler fires', `
    window.__bh.pushSentinelEvent({
      kind: 'paste_handler_failure', severity: 'minor',
      rootCause: 'Paste of image/png into #editor did not populate field — paste event handler absent or threw',
    });
  `),
  '/paste-handler-silent': html('paste handler silent', '/* no sentinel — paste handled */'),

  // ---- autofill_state_desync ----
  '/autofill-desync-fires': html('autofill desync fires', `
    window.__bh.pushSentinelEvent({
      kind: 'autofill_state_desync', severity: 'minor',
      rootCause: 'Browser autofill set email to "test@example.com" but React state remained empty (no change event dispatched)',
    });
  `),
  '/autofill-desync-silent': html('autofill desync silent', '/* no sentinel — state synced after autofill */'),

  // ---- animation_state_corruption ----
  '/animation-corruption-fires': html('animation state corruption fires', `
    window.__bh.pushSentinelEvent({
      kind: 'animation_state_corruption', severity: 'minor',
      rootCause: 'CSS animation on .modal-enter left element in display:none after animation ended — state corrupted',
    });
  `),
  '/animation-corruption-silent': html('animation corruption silent', '/* no sentinel — animation completed cleanly */'),

  // ---- print_stylesheet_broken ----
  '/print-stylesheet-fires': html('print stylesheet fires', `
    window.__bh.pushSentinelEvent({
      kind: 'print_stylesheet_broken', severity: 'info',
      rootCause: '@media print missing — page renders with dark background and overflow: hidden in print preview',
    });
  `),
  '/print-stylesheet-silent': html('print stylesheet silent', '/* no sentinel — print stylesheet present */'),

  // ---- reduced_motion_violation ----
  '/reduced-motion-fires': html('reduced motion fires', `
    window.__bh.pushSentinelEvent({
      kind: 'reduced_motion_violation', severity: 'minor',
      rootCause: 'CSS animation transition: all 0.5s not wrapped in @media (prefers-reduced-motion: no-preference)',
    });
  `),
  '/reduced-motion-silent': html('reduced motion silent', '/* no sentinel — animation respects prefers-reduced-motion */'),

  // ---- forced_colors_failure ----
  '/forced-colors-fires': html('forced colors fires', `
    window.__bh.pushSentinelEvent({
      kind: 'forced_colors_failure', severity: 'minor',
      rootCause: 'Button border invisible in forced-colors mode — border-color hardcoded to transparent without @media (forced-colors)',
    });
  `),
  '/forced-colors-silent': html('forced colors silent', '/* no sentinel — forced colors handled */'),

  // ---- dark_mode_layout_break ----
  '/dark-mode-fires': html('dark mode fires', `
    window.__bh.pushSentinelEvent({
      kind: 'dark_mode_layout_break', severity: 'minor',
      rootCause: 'Header text color #fff on #fff background in dark mode — text invisible due to missing @media (prefers-color-scheme: dark) rule',
    });
  `),
  '/dark-mode-silent': html('dark mode silent', '/* no sentinel — dark mode styles applied correctly */'),

  // ---- zoom_layout_break ----
  '/zoom-layout-fires': html('zoom layout fires', `
    window.__bh.pushSentinelEvent({
      kind: 'zoom_layout_break', severity: 'minor',
      rootCause: 'Navigation overflow at 200% zoom — fixed-width 800px nav exceeds viewport, horizontal scrollbar appears',
    });
  `),
  '/zoom-layout-silent': html('zoom layout silent', '/* no sentinel — layout reflows correctly at 200% zoom */'),

  '/clean': html('clean', '/* nothing */'),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === '/__bughunter_reset') { res.writeHead(200); res.end('ok'); return; }
  const body = ROUTES[pathname];
  if (body !== undefined) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`interaction-palette-mini ready on port ${PORT}\n`));
