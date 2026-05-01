// Snapshot the rendered prompt for a fixture cluster.
import { describe, it, expect } from 'vitest';
import { renderPrompt } from './prompt.js';
import type { BugCluster } from '../types.js';
import type { FileExcerpt } from './excerpt.js';

function makeCluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'c1',
    kind: 'console_error',
    signatureKey: 'console_error|TypeError|abc123',
    rootCause: 'TypeError: Cannot read property "token" of undefined',
    clusterSize: 4,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T01:00:00.000Z',
    occurrences: [
      {
        id: 'occ-1',
        role: 'admin',
        page: '/dashboard',
        action: { kind: 'click', selector: '#submit', toolId: undefined },
        screenshot: undefined,
        dom: undefined,
        consoleLog: undefined,
        networkLog: undefined,
      },
    ],
    suspectedFiles: ['src/auth/login.tsx'],
    fixHints: [],
    thirdPartyOrGenerated: false,
    ...overrides,
  } as unknown as BugCluster;
}

describe('renderPrompt', () => {
  it('contains all four required section headers', () => {
    const cluster = makeCluster();
    const prompt = renderPrompt(cluster, []);
    expect(prompt).toContain('## What\'s happening');
    expect(prompt).toContain('## Likely root cause');
    expect(prompt).toContain('## How to fix');
    expect(prompt).toContain('## What to verify after the fix');
  });

  it('includes cluster metadata', () => {
    const cluster = makeCluster();
    const prompt = renderPrompt(cluster, []);
    expect(prompt).toContain('console_error');
    expect(prompt).toContain('console_error|TypeError|abc123');
    expect(prompt).toContain('Cannot read property "token" of undefined');
  });

  it('includes file excerpts when provided', () => {
    const cluster = makeCluster();
    const excerpts: FileExcerpt[] = [
      {
        path: 'src/auth/login.tsx',
        firstLine: 1,
        lastLine: 10,
        content: 'export function login() { return null; }',
      },
    ];
    const prompt = renderPrompt(cluster, excerpts);
    expect(prompt).toContain('src/auth/login.tsx');
    expect(prompt).toContain('export function login()');
  });

  it('omits Evidence section when no excerpts provided', () => {
    const cluster = makeCluster();
    const prompt = renderPrompt(cluster, []);
    expect(prompt).not.toContain('## Evidence');
  });

  it('includes Evidence section when excerpts provided', () => {
    const cluster = makeCluster();
    const excerpts: FileExcerpt[] = [
      { path: 'src/foo.ts', firstLine: 1, lastLine: 5, content: 'const x = 1;' },
    ];
    const prompt = renderPrompt(cluster, excerpts);
    expect(prompt).toContain('## Evidence');
  });

  it('falls back to (no occurrences) when cluster has no occurrences', () => {
    const cluster = makeCluster({ occurrences: [] as never[] });
    const prompt = renderPrompt(cluster, []);
    expect(prompt).toContain('(no occurrences)');
  });

  it('truncates prompt at 100,000 chars', () => {
    // Simulate a very large content
    const bigContent = 'x'.repeat(200_000);
    const excerpts: FileExcerpt[] = [
      { path: 'src/big.ts', firstLine: 1, lastLine: 100, content: bigContent },
    ];
    const cluster = makeCluster();
    const prompt = renderPrompt(cluster, excerpts);
    expect(prompt.length).toBeLessThanOrEqual(100_100); // some slack for the truncation message
    expect(prompt).toContain('truncated');
  });
});
