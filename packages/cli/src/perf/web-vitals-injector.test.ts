// Tests for web-vitals injector.

import { describe, it, expect } from 'vitest';
import { getInjectionScript } from './web-vitals-injector.js';

describe('getInjectionScript', () => {
  it('returns a non-empty string', () => {
    const script = getInjectionScript();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  it('contains web-vitals UMD code (webVitals export)', () => {
    const script = getInjectionScript();
    expect(script).toContain('webVitals');
  });

  it('sets up window.__bughunter_vitals__', () => {
    const script = getInjectionScript();
    expect(script).toContain('__bughunter_vitals__');
  });

  it('sets up window.__bughunter_long_tasks__', () => {
    const script = getInjectionScript();
    expect(script).toContain('__bughunter_long_tasks__');
  });

  it('sets up window.__bughunter_render_events__', () => {
    const script = getInjectionScript();
    expect(script).toContain('__bughunter_render_events__');
  });

  it('registers React DevTools hook via onCommitFiberRoot', () => {
    const script = getInjectionScript();
    expect(script).toContain('onCommitFiberRoot');
    expect(script).toContain('__REACT_DEVTOOLS_GLOBAL_HOOK__');
  });

  it('chains original onCommitFiberRoot handler', () => {
    const script = getInjectionScript();
    // Must call orig.call to avoid breaking existing DevTools
    expect(script).toContain('orig.call(hook, id, root)');
  });

  it('caps walk depth at 50 to prevent stack overflow', () => {
    const script = getInjectionScript();
    expect(script).toContain('depth > 50');
  });

  it('is stable across multiple calls (cached)', () => {
    const s1 = getInjectionScript();
    const s2 = getInjectionScript();
    expect(s1).toBe(s2);
  });

  it('contains onLCP onINP onCLS registrations', () => {
    const script = getInjectionScript();
    expect(script).toContain('onLCP');
    expect(script).toContain('onINP');
    expect(script).toContain('onCLS');
  });
});
