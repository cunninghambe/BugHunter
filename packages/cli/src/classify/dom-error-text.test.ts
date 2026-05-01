// Unit tests for classifyDomErrorText (V24, spec §3.3, acceptance criterion 3).

import { describe, it, expect } from 'vitest';
import { classifyDomErrorText } from './dom-error-text.js';

describe('classifyDomErrorText', () => {
  it('returns null for empty snippet', () => {
    expect(classifyDomErrorText('', '/test', '')).toBeNull();
  });

  it('returns null for snippet with no error pattern', () => {
    expect(classifyDomErrorText('Everything is fine here.', '/test', '')).toBeNull();
  });

  it('emits dom_error_text when snippet contains "failed to"', () => {
    const result = classifyDomErrorText('failed to load the resource', '/products', 'div.error');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
    expect(result!.pageRoute).toBe('/products');
    expect(result!.selectorClass).toBe('div.error');
    expect(result!.rootCause).toContain('failed to load the resource');
  });

  it('emits dom_error_text for mixed-case "Something went wrong"', () => {
    const result = classifyDomErrorText('Something went wrong', '/checkout', '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
    expect(result!.rootCause).toContain('Something went wrong');
  });

  it('emits dom_error_text for "an error occurred"', () => {
    const result = classifyDomErrorText('An error occurred while loading', '/dashboard', '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
  });

  it('emits dom_error_text for "unable to"', () => {
    const result = classifyDomErrorText('Unable to connect to server', '/settings', '');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('dom_error_text');
  });
});
