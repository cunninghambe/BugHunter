// Accessibility classification — delta-only (§ 3.5).
// Only enabled with --a11y flag.

import type { BugDetection } from '../types.js';

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
