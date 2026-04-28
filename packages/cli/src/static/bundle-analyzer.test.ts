// Tests for bundle-size analyzer (§3.2).

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { analyzeBundles } from './bundle-analyzer.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/bundles');

describe('analyzeBundles', () => {
  it('small fixture: under both thresholds — no budget exceeded', () => {
    const result = analyzeBundles({
      distPath: join(FIXTURES, 'small'),
      jsThresholdGzipBytes: 500 * 1024,
      cssThresholdGzipBytes: 200 * 1024,
    });
    expect(result.exceedsJsBudget).toBe(false);
    expect(result.exceedsCssBudget).toBe(false);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it('small fixture: all assets have initialRoute set based on index.html', () => {
    const result = analyzeBundles({ distPath: join(FIXTURES, 'small') });
    const jsArtifact = result.artifacts.find(a => a.kind === 'js');
    const cssArtifact = result.artifacts.find(a => a.kind === 'css');
    // Both should be initial-route (referenced in index.html)
    expect(jsArtifact?.initialRoute).toBe(true);
    expect(cssArtifact?.initialRoute).toBe(true);
  });

  it('large-js fixture: JS exceeds 500KB gzipped → exceedsJsBudget', () => {
    const result = analyzeBundles({
      distPath: join(FIXTURES, 'large-js'),
      jsThresholdGzipBytes: 500 * 1024,
      cssThresholdGzipBytes: 200 * 1024,
    });
    expect(result.exceedsJsBudget).toBe(true);
    expect(result.exceedsCssBudget).toBe(false);
    expect(result.totalInitialJsGzip).toBeGreaterThan(500 * 1024);
  });

  it('large-css fixture: CSS exceeds 200KB gzipped → exceedsCssBudget', () => {
    const result = analyzeBundles({
      distPath: join(FIXTURES, 'large-css'),
      jsThresholdGzipBytes: 500 * 1024,
      cssThresholdGzipBytes: 200 * 1024,
    });
    expect(result.exceedsCssBudget).toBe(true);
    expect(result.exceedsJsBudget).toBe(false);
    expect(result.totalInitialCssGzip).toBeGreaterThan(200 * 1024);
  });

  it('artifacts include path and kind fields', () => {
    const result = analyzeBundles({ distPath: join(FIXTURES, 'small') });
    for (const a of result.artifacts) {
      expect(typeof a.path).toBe('string');
      expect(['js', 'css', 'html', 'asset']).toContain(a.kind);
      expect(a.bytesRaw).toBeGreaterThan(0);
      expect(a.bytesGzipped).toBeGreaterThan(0);
    }
  });

  it('html file is classified as html kind', () => {
    const result = analyzeBundles({ distPath: join(FIXTURES, 'small') });
    const htmlArtifact = result.artifacts.find(a => a.kind === 'html');
    expect(htmlArtifact).toBeDefined();
  });

  it('non-initial-route assets are excluded from totals', () => {
    // The small fixture has a lazy chunk not referenced in index.html
    // We test by ensuring the total reflects only what's in index.html
    const result = analyzeBundles({ distPath: join(FIXTURES, 'small') });
    const initialJs = result.artifacts.filter(a => a.kind === 'js' && a.initialRoute);
    const totalCalc = initialJs.reduce((s, a) => s + a.bytesGzipped, 0);
    expect(result.totalInitialJsGzip).toBe(totalCalc);
  });

  it('distPath that does not exist returns empty artifacts', () => {
    const result = analyzeBundles({ distPath: '/nonexistent/dist/path' });
    expect(result.artifacts).toHaveLength(0);
    expect(result.exceedsJsBudget).toBe(false);
    expect(result.exceedsCssBudget).toBe(false);
  });
});
