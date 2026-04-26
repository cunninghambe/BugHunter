import { describe, it, expect } from 'vitest';
import { clusterSignature } from '../src/cluster/signature.js';
import { normalizeErrorMessage, fingerprintStackTrace } from '../src/cluster/normalize.js';
import type { BugDetection } from '../src/types.js';
import stackFixture from '../../fixtures/stack-trace-clustering/stacks.json' assert { type: 'json' };

describe('normalizeErrorMessage', () => {
  it('lowercases and strips numeric ids (4+ digits)', () => {
    const result = normalizeErrorMessage('Error: Failed to fetch from /api/orders/12345');
    expect(result).toBe('error: failed to fetch from /api/orders/<num>');
  });

  it('strips UUIDs', () => {
    const result = normalizeErrorMessage('Missing resource: 550e8400-e29b-41d4-a716-446655440000');
    expect(result).toContain('<id>');
    expect(result).not.toContain('550e8400');
  });

  it('strips hex SHA1 (40 chars)', () => {
    const sha = 'a'.repeat(40);
    const result = normalizeErrorMessage(`Commit ${sha} not found`);
    expect(result).toContain('<id>');
  });

  it('strips double-quoted strings', () => {
    const result = normalizeErrorMessage('Cannot read "productName" property');
    expect(result).toContain('<str>');
    expect(result).not.toContain('productName');
  });

  it('strips single-quoted strings', () => {
    const result = normalizeErrorMessage("Cannot read 'map' property");
    expect(result).toContain('<str>');
  });

  it('truncates to 80 chars', () => {
    const result = normalizeErrorMessage('a'.repeat(200));
    expect(result).toHaveLength(80);
  });
});

describe('fingerprintStackTrace', () => {
  it('strips line and column numbers', () => {
    const stack = 'Error\n    at foo (src/foo.ts:42:5)\n    at bar (src/bar.ts:10:1)';
    const result = fingerprintStackTrace(stack);
    expect(result).not.toMatch(/:\d+/);
  });

  it('filters out node_modules frames', () => {
    const stack = [
      'Error',
      '    at myFunc (src/myFunc.ts:10:5)',
      '    at node_modules/react/index.js:42:3',
      '    at webpack-internal:///./src/index.ts:1:1',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    expect(result).toContain('myFunc');
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('webpack-internal');
  });

  it('takes at most 3 user-code frames', () => {
    const stack = [
      'Error',
      '    at func1 (src/a.ts:1:1)',
      '    at func2 (src/b.ts:2:2)',
      '    at func3 (src/c.ts:3:3)',
      '    at func4 (src/d.ts:4:4)',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    const frames = result.split('|').filter(Boolean);
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it('uses | separator', () => {
    const stack = [
      'Error',
      '    at func1 (src/a.ts:1:1)',
      '    at func2 (src/b.ts:2:2)',
    ].join('\n');
    const result = fingerprintStackTrace(stack);
    expect(result).toContain('|');
  });
});

describe('cluster signature — 10 known stacks → 3 clusters', () => {
  it('groups correctly per fixture', () => {
    const signatures = new Map<string, string>();

    for (const stack of stackFixture.stacks) {
      const detection: BugDetection = {
        kind: 'console_error',
        rootCause: stack.message,
        stackTrace: stack.stack,
      };
      const sig = clusterSignature(detection);
      signatures.set(stack.id, sig);
    }

    // Group by signature
    const groups = new Map<string, string[]>();
    for (const [id, sig] of signatures) {
      const stackData = stackFixture.stacks.find(s => s.id === id)!;
      const cluster = stackData.expectedCluster;
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig)!.push(cluster);
    }

    // All items in the same signature group should have the same expectedCluster
    for (const [sig, clusters] of groups) {
      const first = clusters[0];
      expect(clusters.every(c => c === first)).toBe(true);
    }

    // Should produce exactly 3 distinct signatures
    expect(groups.size).toBe(stackFixture.expectedClusterCount);
  });
});

describe('cluster signature — different kinds produce different signatures', () => {
  it('network_5xx keyed by endpoint+status', () => {
    const d1: BugDetection = { kind: 'network_5xx', rootCause: 'x', endpoint: 'POST /api/foo', status: 500 };
    const d2: BugDetection = { kind: 'network_5xx', rootCause: 'y', endpoint: 'POST /api/foo', status: 500 };
    const d3: BugDetection = { kind: 'network_5xx', rootCause: 'z', endpoint: 'GET /api/bar', status: 503 };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d3));
  });

  it('404_for_linked_route keyed by targetPath', () => {
    const d1: BugDetection = { kind: '404_for_linked_route', rootCause: 'x', targetPath: '/missing' };
    const d2: BugDetection = { kind: '404_for_linked_route', rootCause: 'y', targetPath: '/missing' };
    const d3: BugDetection = { kind: '404_for_linked_route', rootCause: 'z', targetPath: '/other' };
    expect(clusterSignature(d1)).toBe(clusterSignature(d2));
    expect(clusterSignature(d1)).not.toBe(clusterSignature(d3));
  });
});
