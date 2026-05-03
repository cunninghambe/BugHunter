// Accessibility classification — delta-only (§ 3.5).
// Only enabled with --a11y flag.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { BugDetection } from '../types.js';

const _require = createRequire(import.meta.url);
const _axeMinPath: string = _require.resolve('axe-core/axe.min.js');
const _axeSource: string = fs.readFileSync(_axeMinPath, 'utf8');

/**
 * Evaluating this script on a page installs window.axe if not already present.
 * Must be eval'd before AXE_RUN_SCRIPT.
 */
export const AXE_INJECT_SCRIPT: string = `(function(){if(!window.axe){${_axeSource}}})()`;


export type A11yViolation = {
  id: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  nodes: unknown[];
};

// Script to run axe-core (must be loaded on page).
export const AXE_RUN_SCRIPT = `
(function() {
  if (!window.axe) return { violations: [] };
  return new Promise(resolve => {
    window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })
      .then(results => resolve({ violations: results.violations }))
      .catch(() => resolve({ violations: [] }));
  });
})()
`;

// v0.41: axe script that also runs target-size (touch target AA) for mobile viewports.
export const AXE_RUN_SCRIPT_MOBILE = `
(function() {
  if (!window.axe) return { violations: [] };
  return new Promise(resolve => {
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
      rules: { 'target-size': { enabled: true } }
    })
      .then(results => resolve({ violations: results.violations }))
      .catch(() => resolve({ violations: [] }));
  });
})()
`;

/**
 * Returns the axe run script appropriate for the current viewport.
 * Mobile viewports enable the `target-size` rule for touch-target AA checks (#152).
 */
export function getAxeScript(mobile: boolean): string {
  return mobile ? AXE_RUN_SCRIPT_MOBILE : AXE_RUN_SCRIPT;
}

export function classifyA11yDelta(
  preViolations: A11yViolation[],
  postViolations: A11yViolation[],
  pageRoute: string
): BugDetection[] {
  const preIds = new Set(preViolations.map(v => v.id));
  const newViolations = postViolations.filter(
    v => !preIds.has(v.id) && (v.impact === 'critical' || v.impact === 'serious')
  );

  return newViolations.map(v => ({
    kind: 'accessibility_critical' as const,
    rootCause: `Accessibility violation introduced: ${v.id} — ${v.description}`,
    pageRoute,
    selectorClass: v.id,
    a11yViolations: v.nodes,
  }));
}
