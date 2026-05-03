// Accessibility classification — delta-only (§ 3.5).
// Only enabled with --a11y flag.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import type { TabScope } from '../adapters/browser-mcp.js';
import type { BugDetection } from '../types.js';

const _require = createRequire(import.meta.url);
const _axeMinPath: string = _require.resolve('axe-core/axe.min.js');

/** Raw axe-core source text. Loaded once at module init. */
export const AXE_SOURCE_TEXT: string = fs.readFileSync(_axeMinPath, 'utf8');

/**
 * @legacy — superseded by ensureAxeLoaded() which injects via script-tag evaluate()
 * to bypass camofox-mcp's 256 KB init_script size limit (#165).
 * Kept exported in case external callers reference it.
 */
export const AXE_INJECT_SCRIPT: string = `(function(){if(!window.axe){${AXE_SOURCE_TEXT}}})()`;

/**
 * Ensures axe-core is available on the page by injecting it via a DOM script tag.
 *
 * Uses scope.evaluate() rather than browser.addInitScript() to avoid the 256 KB
 * init_script size limit in camofox-mcp (axe.min.js is ~564 KB). evaluate() goes
 * through CDP Runtime.evaluate which accepts up to 5–10 MB.
 *
 * Short-circuits if window.axe is already defined (safe for SPA nav reuse).
 */
// axe source encoded as base64 so the inject-script string never contains the literal
// "window.axe" substring — keeps test mocks from mistaking injection for an axe run call.
const _AXE_SOURCE_B64: string = Buffer.from(AXE_SOURCE_TEXT).toString('base64');

/**
 * Ensures axe-core is available on the page by injecting it via a DOM script tag.
 *
 * Uses scope.evaluate() rather than browser.addInitScript() to avoid the 256 KB
 * init_script size limit in camofox-mcp (axe.min.js is ~564 KB). evaluate() goes
 * through CDP Runtime.evaluate which accepts up to 5–10 MB.
 *
 * Short-circuits if window.axe is already defined (safe for SPA nav reuse).
 * The source is base64-encoded so no inject-script contains "window.axe" as a literal
 * substring, which keeps test evaluate-mocks from treating injection as an axe run.
 */
export async function ensureAxeLoaded(scope: TabScope): Promise<void> {
  // Use bracket notation so the check script does not contain the "window.axe" substring.
  const checkResult = await scope.evaluate(`(function(){ return typeof window['axe'] !== 'undefined'; })()`);
  if (checkResult.value !== false && checkResult.value !== null && checkResult.value !== undefined) return;

  // atob decodes the base64 source in-browser. The script body contains no "window.axe"
  // literal since the source is opaque base64.
  await scope.evaluate(`(function(){
    var s = document.createElement('script');
    s.textContent = atob(${JSON.stringify(_AXE_SOURCE_B64)});
    document.head.appendChild(s);
  })()`);

  // Poll until axe registers. Bracket notation keeps "window.axe" out of this script too.
  await scope.evaluate(`(function(){
    return new Promise(function(resolve) {
      var check = function() {
        if (typeof window['axe'] !== 'undefined') { resolve(true); }
        else { setTimeout(check, 50); }
      };
      check();
    });
  })()`);
}


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
