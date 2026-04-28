// Unit tests for trigger-resolve.ts (§ 6.2)

import { describe, it, expect, vi } from 'vitest';
import { resolveTriggerSelector, selectorExists } from './trigger-resolve.js';
import type { EvaluatorLike } from './trigger-resolve.js';

function makeEvaluator(domQueryResults: Record<string, boolean>): EvaluatorLike {
  return {
    evaluate: vi.fn(async (script: string) => {
      // Extract the selector from the querySelector call in the script
      const match = /document\.querySelector\((.+?)\)/.exec(script);
      if (!match) return { value: false };
      // The selector is JSON.stringify'd in the script, so parse it
      const sel = JSON.parse(match[1]) as string;
      return { value: domQueryResults[sel] ?? false };
    }),
  };
}

describe('selectorExists', () => {
  it('returns true when selector exists in DOM', async () => {
    const browser = makeEvaluator({ '[data-testid="btn"]': true });
    expect(await selectorExists(browser, '[data-testid="btn"]')).toBe(true);
  });

  it('returns false when selector absent from DOM', async () => {
    const browser = makeEvaluator({});
    expect(await selectorExists(browser, '[data-testid="missing"]')).toBe(false);
  });
});

describe('resolveTriggerSelector', () => {
  it('data-testid present and found — returns testid selector', async () => {
    const browser = makeEvaluator({ '[data-testid="dashboard-btn"]': true });
    const result = await resolveTriggerSelector(browser, { testId: 'dashboard-btn', text: 'Dashboard', ariaLabel: 'Go to dashboard' });
    expect(result).toBe('[data-testid="dashboard-btn"]');
  });

  it('data-testid absent from DOM — falls through to aria-label', async () => {
    const browser = makeEvaluator({ '[aria-label="Go to dashboard"]': true });
    const result = await resolveTriggerSelector(browser, { testId: 'missing-id', ariaLabel: 'Go to dashboard', text: 'Dashboard' });
    expect(result).toBe('[aria-label="Go to dashboard"]');
  });

  it('aria-label fallback — no testid provided', async () => {
    const browser = makeEvaluator({ '[aria-label="My profile"]': true });
    const result = await resolveTriggerSelector(browser, { ariaLabel: 'My profile', text: 'Profile' });
    expect(result).toBe('[aria-label="My profile"]');
  });

  it('text-only hint — returns :has-text() selector', async () => {
    const browser = makeEvaluator({});
    const result = await resolveTriggerSelector(browser, { text: 'Dashboard' });
    expect(result).toBe(':has-text("Dashboard")');
  });

  it('no hint fields — returns null', async () => {
    const browser = makeEvaluator({});
    const result = await resolveTriggerSelector(browser, {});
    expect(result).toBeNull();
  });

  it('all hints empty strings — returns null', async () => {
    const browser = makeEvaluator({});
    const result = await resolveTriggerSelector(browser, { testId: '', ariaLabel: '', text: '' });
    // Empty strings are falsy, so all branches are skipped
    expect(result).toBeNull();
  });

  it('escapes double-quotes in testId', async () => {
    const browser = makeEvaluator({ '[data-testid="say-\\"hello\\""]': true });
    const result = await resolveTriggerSelector(browser, { testId: 'say-"hello"' });
    expect(result).toBe('[data-testid="say-\\"hello\\""]');
  });

  it('escapes double-quotes in text for :has-text()', async () => {
    const browser = makeEvaluator({});
    const result = await resolveTriggerSelector(browser, { text: 'say "hi"' });
    expect(result).toBe(':has-text("say \\"hi\\"")');
  });
});
