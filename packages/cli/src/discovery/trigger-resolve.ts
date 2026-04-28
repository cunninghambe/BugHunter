/**
 * @deprecated Click flows should use `BrowserMcpAdapter.clickByHint(hint)` instead.
 * `resolveTriggerSelector` returns a bare `:has-text("…")` string for text-only hints,
 * which is not valid CSS and is rejected by the adapter's snapshot resolver. It is kept
 * here to avoid breaking non-click probe callers, but the crawler no longer uses it.
 */
// Resolves a TriggerSelectorHint to a concrete CSS selector usable by BrowserMcpAdapter.click.

import type { TriggerSelectorHint } from '../types.js';
import type { EvaluateResult } from '../adapters/browser-mcp.js';

/** Minimal interface needed for trigger resolution — satisfied by both BrowserMcpAdapter and TabScope. */
export type EvaluatorLike = {
  evaluate(script: string): Promise<EvaluateResult>;
};

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function selectorExists(browser: EvaluatorLike, sel: string): Promise<boolean> {
  const result = await browser.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  return result.value === true;
}

/**
 * Resolves a hint to the highest-priority selector that exists in the live DOM.
 *
 * Priority:
 * 1. data-testid (strongest — authoring intent)
 * 2. aria-label
 * 3. text content via :has-text() (weakest — ambiguous if text is non-unique)
 *
 * Returns null when no hint resolves.
 */
export async function resolveTriggerSelector(
  browser: EvaluatorLike,
  hint: TriggerSelectorHint
): Promise<string | null> {
  if (hint.testId !== undefined && hint.testId !== '') {
    const sel = `[data-testid="${escapeAttr(hint.testId)}"]`;
    if (await selectorExists(browser, sel)) return sel;
  }

  if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') {
    const sel = `[aria-label="${escapeAttr(hint.ariaLabel)}"]`;
    if (await selectorExists(browser, sel)) return sel;
  }

  if (hint.text !== undefined && hint.text !== '') {
    // :has-text() is a Playwright pseudo-selector resolved by BrowserMcpAdapter.click.
    return `:has-text("${escapeAttr(hint.text)}")`;
  }

  return null;
}
