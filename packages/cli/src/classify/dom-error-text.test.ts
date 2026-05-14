// Unit tests for classifyDomErrorText (V24 + v0.51 tightening).
//
// The v0.51 tightening is documented in docs/benchmarks/BENCHMARK_SPOONWORKS.md:
// without a container indicator the detector produced 30/30 FPs on a real app.

import { describe, it, expect } from 'vitest';
import { classifyDomErrorText } from './dom-error-text.js';

describe('classifyDomErrorText — pattern matching', () => {
  it('returns null for empty snippet', () => {
    expect(classifyDomErrorText('', '/test', '')).toBeNull();
  });

  it('returns null for snippet with no error pattern', () => {
    expect(classifyDomErrorText('Everything is fine here.', '/test', '')).toBeNull();
  });

  it('emits dom_error_text when snippet contains "failed to" (with indicator)', () => {
    const result = classifyDomErrorText(
      'failed to load the resource', '/products', 'div.error',
      { source: 'class', value: 'error' },
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
    expect(result!.pageRoute).toBe('/products');
  });

  it('emits dom_error_text for mixed-case "Something went wrong"', () => {
    const result = classifyDomErrorText(
      'Something went wrong', '/checkout', '',
      { source: 'role', value: 'alert' },
    );
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
  });

  it('emits dom_error_text for "an error occurred"', () => {
    const result = classifyDomErrorText(
      'An error occurred while loading', '/dashboard', '',
      { source: 'role', value: 'alert' },
    );
    expect(result).not.toBeNull();
  });

  it('emits dom_error_text for "unable to"', () => {
    const result = classifyDomErrorText(
      'Unable to connect to server', '/settings', '',
      { source: 'aria-live', value: 'assertive' },
    );
    expect(result).not.toBeNull();
  });
});

describe('classifyDomErrorText — v0.51 route exclusion', () => {
  it('skips /policies routes (boilerplate text concentrates here)', () => {
    const result = classifyDomErrorText(
      'unable to refund without receipt', '/policies/returns', '',
      { source: 'class', value: 'error' },
    );
    expect(result).toBeNull();
  });

  it('skips /legal routes', () => {
    expect(classifyDomErrorText(
      'failed to load any cookies', '/legal/cookies', '',
      { source: 'role', value: 'alert' },
    )).toBeNull();
  });

  it('skips /terms, /privacy, /tos', () => {
    for (const route of ['/terms', '/privacy', '/tos', '/terms-of-service']) {
      expect(classifyDomErrorText(
        'unable to process', route, '',
        { source: 'role', value: 'alert' },
      )).toBeNull();
    }
  });

  it('skips /about, /faq, /contact, /help', () => {
    for (const route of ['/about', '/faq', '/contact-us', '/help']) {
      expect(classifyDomErrorText(
        'something went wrong', route, '',
        { source: 'role', value: 'alert' },
      )).toBeNull();
    }
  });

  it('still fires on /products even with boilerplate-ish prose', () => {
    const result = classifyDomErrorText(
      'unable to load the product page', '/products/foo', '',
      { source: 'role', value: 'alert' },
    );
    expect(result).not.toBeNull();
  });
});

describe('classifyDomErrorText — rootCause includes indicator evidence', () => {
  it('records role-based container in rootCause', () => {
    const r = classifyDomErrorText(
      'failed to load', '/dash', '',
      { source: 'role', value: 'alert' },
    );
    expect(r?.rootCause).toContain('role');
    expect(r?.rootCause).toContain('alert');
  });

  it('records aria-live container in rootCause', () => {
    const r = classifyDomErrorText(
      'failed to load', '/dash', '',
      { source: 'aria-live', value: 'polite' },
    );
    expect(r?.rootCause).toContain('aria-live');
  });

  it('records class-based container in rootCause', () => {
    const r = classifyDomErrorText(
      'failed to load', '/dash', '',
      { source: 'class', value: 'toast' },
    );
    expect(r?.rootCause).toContain('class');
    expect(r?.rootCause).toContain('toast');
  });

  it('omits the per-indicator evidence parenthetical when no indicator provided', () => {
    const r = classifyDomErrorText('failed to load', '/dash', '');
    // Always-present 'container' header phrase is fine; the parenthetical
    // "(container: <source>=..." should be absent.
    expect(r?.rootCause).not.toMatch(/\(container:/);
  });
});
