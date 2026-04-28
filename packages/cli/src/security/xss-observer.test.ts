// Tests for xss-observer module (v0.7 T01) — sanity checks on script strings.

import { describe, it, expect } from 'vitest';
import { XSS_OBSERVER_START_SCRIPT, XSS_OBSERVER_DRAIN_SCRIPT } from './xss-observer.js';

describe('XSS_OBSERVER_START_SCRIPT', () => {
  it('is a non-empty string', () => {
    expect(typeof XSS_OBSERVER_START_SCRIPT).toBe('string');
    expect(XSS_OBSERVER_START_SCRIPT.length).toBeGreaterThan(0);
  });

  it('contains idempotency guard', () => {
    expect(XSS_OBSERVER_START_SCRIPT).toContain('__bh_xss_installed');
  });

  it('initialises the __bh_xss Map', () => {
    expect(XSS_OBSERVER_START_SCRIPT).toContain('window.__bh_xss');
    expect(XSS_OBSERVER_START_SCRIPT).toContain('new Map');
  });

  it('installs sweep interval for window_assign sink', () => {
    expect(XSS_OBSERVER_START_SCRIPT).toContain('setInterval');
    expect(XSS_OBSERVER_START_SCRIPT).toContain('window_assign');
  });

  it('installs MutationObserver for dom_inserted sink', () => {
    expect(XSS_OBSERVER_START_SCRIPT).toContain('MutationObserver');
    expect(XSS_OBSERVER_START_SCRIPT).toContain('dom_inserted');
  });
});

describe('XSS_OBSERVER_DRAIN_SCRIPT', () => {
  it('is a non-empty string', () => {
    expect(typeof XSS_OBSERVER_DRAIN_SCRIPT).toBe('string');
    expect(XSS_OBSERVER_DRAIN_SCRIPT.length).toBeGreaterThan(0);
  });

  it('reads from window.__bh_xss', () => {
    expect(XSS_OBSERVER_DRAIN_SCRIPT).toContain('window.__bh_xss');
  });

  it('clears the map after draining', () => {
    expect(XSS_OBSERVER_DRAIN_SCRIPT).toContain('.clear()');
  });

  it('returns an array', () => {
    expect(XSS_OBSERVER_DRAIN_SCRIPT).toContain('out');
    expect(XSS_OBSERVER_DRAIN_SCRIPT).toContain('return out');
  });
});
