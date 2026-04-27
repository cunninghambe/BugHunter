import { describe, it, expect } from 'vitest';
import { MUTATION_OBSERVER_START_SCRIPT } from '../src/classify/state-change.js';

describe('MUTATION_OBSERVER_START_SCRIPT — IIFE parse validity', () => {
  it('parses as a valid expression (Playwright page.evaluate compatibility)', () => {
    // Playwright's page.evaluate(string) requires a single expression.
    // Wrapping in new Function checks that the script is syntactically valid
    // as an expression without requiring a browser.
    expect(() => {
      new Function('"use strict"; return (' + MUTATION_OBSERVER_START_SCRIPT + ')');
    }).not.toThrow();
  });

  it('is an IIFE (wrapped in parentheses on first and last non-whitespace char)', () => {
    const trimmed = MUTATION_OBSERVER_START_SCRIPT.trim();
    expect(trimmed.startsWith('(')).toBe(true);
    expect(trimmed.endsWith(')')).toBe(true);
  });
});
