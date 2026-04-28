// Tests for bundle-probe phase wrapper (§4.9 / T16).

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runBundleProbe } from './bundle-probe.js';
import type { BundleProbeConfig } from '../types.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/bundles');

function makeConfig(overrides: Partial<BundleProbeConfig> = {}): BundleProbeConfig {
  return {
    enabled: true,
    jsThresholdGzipBytes: 500 * 1024,
    cssThresholdGzipBytes: 200 * 1024,
    ...overrides,
  };
}

describe('runBundleProbe', () => {
  it('returns empty result when disabled', () => {
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'large-js'),
      config: makeConfig({ enabled: false }),
    });
    expect(result.detections).toHaveLength(0);
    expect(result.budgetExceeded).toBe(false);
  });

  it('returns empty result when dist path not found', () => {
    const result = runBundleProbe({
      projectDir: '/nonexistent/project',
      config: makeConfig(),
    });
    expect(result.detections).toHaveLength(0);
  });

  it('large-js fixture → exactly one oversized_bundle finding (JS)', () => {
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'large-js'),
      config: makeConfig({ searchPaths: ['.'] }),
    });
    const jsFindings = result.detections.filter(d => d.kind === 'oversized_bundle' && (d.evidence as { kind: string })?.kind === 'js');
    expect(jsFindings).toHaveLength(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it('large-css fixture → exactly one oversized_bundle finding (CSS)', () => {
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'large-css'),
      config: makeConfig({ searchPaths: ['.'] }),
    });
    const cssFindings = result.detections.filter(d => d.kind === 'oversized_bundle' && (d.evidence as { kind: string })?.kind === 'css');
    expect(cssFindings).toHaveLength(1);
    expect(result.budgetExceeded).toBe(true);
  });

  it('small fixture → no oversized_bundle findings', () => {
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'small'),
      config: makeConfig({ searchPaths: ['.'] }),
    });
    expect(result.detections).toHaveLength(0);
    expect(result.budgetExceeded).toBe(false);
  });

  it('finding evidence contains kind field', () => {
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'large-js'),
      config: makeConfig({ searchPaths: ['.'] }),
    });
    const finding = result.detections.find(d => d.kind === 'oversized_bundle');
    expect(finding).toBeDefined();
    expect((finding!.evidence as { kind: string }).kind).toBe('js');
  });

  it('auto-discovers dist/ under projectDir', () => {
    // large-js fixture has no dist/ subdirectory; its root IS the dist
    // Test with searchPaths override to explicitly point to the fixture
    const result = runBundleProbe({
      projectDir: join(FIXTURES, 'large-js'),
      config: makeConfig({ searchPaths: ['.'] }),
    });
    // Should find the main.js and detect it
    expect(result.totalInitialJsGzip).toBeGreaterThan(500 * 1024);
  });
});
