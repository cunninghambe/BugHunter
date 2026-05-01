import { describe, it, expect } from 'vitest';
import { classifySignal } from './signal-classifier.js';
import type { ReplayResult } from '../../repro/replay.js';
import type { BisectClusterSnapshot, BugSignal } from '../../types.js';

type ClassifyResult = ReturnType<typeof classifySignal>;

function isBugSignal(r: ClassifyResult): r is BugSignal {
  return !('skip' in r);
}

function makeResult(overrides: Partial<ReplayResult['observation']> = {}, ok = true): ReplayResult {
  return {
    ok,
    observation: {
      consoleErrors: [],
      networkRequests: [],
      domSnapshot: '',
      finalUrl: 'http://localhost:3000/products',
      ...overrides,
    },
  };
}

function makeCluster(overrides: Partial<BisectClusterSnapshot> = {}): BisectClusterSnapshot {
  return {
    id: 'cluster-abc',
    kind: 'dom_error_text',
    rootCause: 'dom_error_text: Something went wrong',
    errorText: 'Something went wrong',
    ...overrides,
  };
}

describe('classifySignal', () => {
  describe('dom_error_text', () => {
    it('present when errorText found in DOM snapshot', () => {
      const result = makeResult({ domSnapshot: 'Page: Something went wrong - contact support' });
      const signal = classifySignal(result, makeCluster());
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(true);
      expect(signal.confidence).toBe('high');
    });

    it('absent (high confidence) when errorText not in DOM', () => {
      const result = makeResult({ domSnapshot: 'Products loaded successfully' });
      const signal = classifySignal(result, makeCluster());
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
      expect(signal.confidence).toBe('high');
    });

    it('inconclusive (low confidence) when no DOM snapshot', () => {
      const result = makeResult({ domSnapshot: undefined });
      const signal = classifySignal(result, makeCluster());
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
      expect(signal.confidence).toBe('low');
    });
  });

  describe('unhandled_exception', () => {
    it('present when console error matches signatureKey', () => {
      const result = makeResult({ consoleErrors: [{ level: 'error', text: 'Uncaught TypeError: Cannot read property x' }] });
      const cluster = makeCluster({ kind: 'unhandled_exception', signatureKey: 'TypeError: Cannot read property x' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(true);
    });

    it('absent when console errors do not match signatureKey', () => {
      const result = makeResult({ consoleErrors: [{ level: 'error', text: 'Some other error' }] });
      const cluster = makeCluster({ kind: 'unhandled_exception', signatureKey: 'TypeError: Cannot read property x' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
      expect(signal.confidence).toBe('high');
    });

    it('absent when no console errors', () => {
      const result = makeResult({ consoleErrors: [] });
      const cluster = makeCluster({ kind: 'unhandled_exception', signatureKey: 'TypeError' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
      expect(signal.confidence).toBe('high');
    });
  });

  describe('network_5xx', () => {
    it('present when 5xx response for matching endpoint', () => {
      const result = makeResult({ networkRequests: [{ method: 'GET', path: '/api/products', status: 500, duration: 100 }] });
      const cluster = makeCluster({ kind: 'network_5xx', endpoint: '/api/products' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(true);
    });

    it('absent when no 5xx response', () => {
      const result = makeResult({ networkRequests: [{ method: 'GET', path: '/api/products', status: 200, duration: 50 }] });
      const cluster = makeCluster({ kind: 'network_5xx', endpoint: '/api/products' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
    });
  });

  describe('xss_reflected', () => {
    it('present when canary found in DOM', () => {
      const result = makeResult({ domSnapshot: '<script>bh-xss-canary-abc123</script>' });
      const cluster = makeCluster({ kind: 'xss_reflected', xssCanary: 'bh-xss-canary-abc123' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(true);
    });

    it('absent when canary not in DOM', () => {
      const result = makeResult({ domSnapshot: 'clean page' });
      const cluster = makeCluster({ kind: 'xss_reflected', xssCanary: 'bh-xss-canary-abc123' });
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
    });
  });

  describe('unsupported kinds', () => {
    it('skips race_condition_* with bisect_nondeterministic_kind', () => {
      const cluster = makeCluster({ kind: 'race_condition_double_submit' });
      const result = makeResult();
      const signal = classifySignal(result, cluster);
      expect('skip' in signal).toBe(true);
      if (!('skip' in signal)) return;
      expect(signal.reason).toBe('bisect_nondeterministic_kind');
    });

    it('skips axe_* with bisect_unsupported_kind', () => {
      const cluster = makeCluster({ kind: 'axe_color_contrast_strong' });
      const result = makeResult();
      const signal = classifySignal(result, cluster);
      expect('skip' in signal).toBe(true);
      if (!('skip' in signal)) return;
      expect(signal.reason).toBe('bisect_unsupported_kind');
    });
  });

  describe('failed replay', () => {
    it('returns inconclusive when replay fails', () => {
      const result: ReplayResult = { ok: false, observation: { consoleErrors: [], networkRequests: [] }, error: 'network error' };
      const cluster = makeCluster();
      const signal = classifySignal(result, cluster);
      expect(isBugSignal(signal)).toBe(true);
      if (!isBugSignal(signal)) return;
      expect(signal.present).toBe(false);
      expect(signal.confidence).toBe('low');
    });
  });
});
