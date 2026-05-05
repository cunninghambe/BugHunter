#!/usr/bin/env node
// a11y-axe-mini — fixture for accessibility_critical and axe_color_contrast_strong.
//
// Production: classify/a11y-baseline.ts + classify/accessibility.ts read axe-core
// violation envelopes. Harness: each fixture page injects axe-shaped violation
// objects via window.__bh.pushAxe(), simulating a successful axe.run() against a
// page with known accessibility issues. Calibrates the classifier+harness pipeline
// on real axe-shaped data without a 600KB axe-core vendor bundle.
//
// Severity mapping (from production):
//  accessibility_critical fires when violation.impact === 'critical' OR 'serious'
//  axe_color_contrast_strong fires when violation.id === 'color-contrast'

'use strict';

const http = require('node:http');
const url = require('node:url');
const { BOOTSTRAP_SOURCE } = require('../../_bh-bootstrap.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9723;

function html(body, axeViolations) {
  const violationsLiteral = JSON.stringify(axeViolations);
  return `<!doctype html><html><head><meta charset="utf-8"><title>a11y-axe</title>
<script>${BOOTSTRAP_SOURCE}</script>
<script>
  (function() {
    const violations = ${violationsLiteral};
    setTimeout(function() {
      if (window.__bh && typeof window.__bh.pushAxe === 'function') {
        violations.forEach(function(v) { window.__bh.pushAxe(v); });
      }
    }, 100);
  })();
</script>
</head><body>${body}</body></html>`;
}

const ROUTES = {
  // accessibility_critical positives — impact serious/critical
  '/a11y-image-alt': html(`<h1>Image</h1>`, [
    { id: 'image-alt', impact: 'critical', nodes: 2, description: 'Images must have alternate text' },
  ]),
  '/a11y-label': html(`<h1>Label</h1>`, [
    { id: 'label', impact: 'serious', nodes: 1, description: 'Form elements must have labels' },
  ]),
  '/a11y-aria-required': html(`<h1>ARIA</h1>`, [
    { id: 'aria-required-attr', impact: 'serious', nodes: 1, description: 'Required ARIA attributes must be provided' },
  ]),
  // axe_color_contrast_strong positives — must have id='color-contrast'
  '/a11y-color-contrast': html(`<h1>Contrast</h1>`, [
    { id: 'color-contrast', impact: 'serious', nodes: 3, description: 'Elements must meet minimum color contrast ratio thresholds' },
  ]),
  // Mixed — both fire (but classifier filters; accessibility_critical sees both, color_contrast filters to its rule)
  '/a11y-mixed': html(`<h1>Mixed</h1>`, [
    { id: 'image-alt', impact: 'critical', nodes: 1, description: 'Images must have alternate text' },
    { id: 'color-contrast', impact: 'serious', nodes: 2, description: 'Elements must meet minimum color contrast ratio thresholds' },
  ]),
  // Negatives
  '/a11y-clean': html(`<h1>Clean</h1><p>no violations</p>`, []),
  '/a11y-only-minor': html(`<h1>Minor</h1>`, [
    { id: 'region', impact: 'moderate', nodes: 1, description: 'All page content should be contained by landmarks' },
  ]),
  // Edge: violation with no impact field — should not fire either detector
  '/a11y-no-impact': html(`<h1>NoImpact</h1>`, [
    { id: 'image-alt', impact: null, nodes: 1, description: 'Images must have alternate text' },
  ]),
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
  process.stdout.write(`a11y-axe-mini ready on port ${PORT}\n`);
});
