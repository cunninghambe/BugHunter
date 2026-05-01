import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, computeFilterHash } from './cursor.js';

describe('cursor', () => {
  it('round-trips a cursor payload', () => {
    const payload = { offset: 50, runId: 'run_001', filterHash: 'abc123def456abcd' };
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it('encodes as base64url (no + or / or =)', () => {
    const payload = { offset: 0, runId: 'run_001', filterHash: 'abc123def456abcd' };
    const encoded = encodeCursor(payload);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('throws on tampered cursor (invalid base64)', () => {
    expect(() => decodeCursor('!!!invalid!!!')).toThrow('invalid cursor');
  });

  it('throws on cursor with missing fields', () => {
    const bad = Buffer.from(JSON.stringify({ offset: 0 })).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow('invalid cursor');
  });

  it('computeFilterHash is stable for same args', () => {
    const h1 = computeFilterHash({ kind: 'console_error', severity: 'major' });
    const h2 = computeFilterHash({ kind: 'console_error', severity: 'major' });
    expect(h1).toBe(h2);
  });

  it('computeFilterHash differs for different args', () => {
    const h1 = computeFilterHash({ kind: 'console_error' });
    const h2 = computeFilterHash({ kind: 'xss_reflected' });
    expect(h1).not.toBe(h2);
  });

  it('computeFilterHash is 16 hex chars', () => {
    const h = computeFilterHash({});
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
