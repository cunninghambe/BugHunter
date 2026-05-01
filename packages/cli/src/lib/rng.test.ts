import { describe, it, expect } from 'vitest';
import { mulberry32, parseSeed } from './rng.js';

describe('mulberry32', () => {
  it('produces values in [0, 1)', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic: same seed → same sequence', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 50; i++) {
      expect(a()).toBe(b());
    }
  });

  it('different seeds → different sequences', () => {
    const a = mulberry32(1234);
    const b = mulberry32(5678);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('seed 0 produces a valid stream', () => {
    const rng = mulberry32(0);
    const v = rng();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('seed 0xFFFFFFFF (max) produces a valid stream', () => {
    const rng = mulberry32(0xFFFFFFFF);
    const v = rng();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe('parseSeed', () => {
  it('accepts zero', () => expect(parseSeed('0')).toBe(0));
  it('accepts max 32-bit uint', () => expect(parseSeed('4294967295')).toBe(0xFFFFFFFF));
  it('accepts a typical seed', () => expect(parseSeed('1234')).toBe(1234));

  it('rejects negative', () => {
    expect(() => parseSeed('-1')).toThrow("--seed must be a 32-bit non-negative integer; got '-1'");
  });
  it('rejects non-integer float', () => {
    expect(() => parseSeed('1.5')).toThrow("--seed must be a 32-bit non-negative integer; got '1.5'");
  });
  it('rejects non-numeric', () => {
    expect(() => parseSeed('abc')).toThrow("--seed must be a 32-bit non-negative integer; got 'abc'");
  });
  it('rejects overflow', () => {
    expect(() => parseSeed('4294967296')).toThrow("--seed must be a 32-bit non-negative integer; got '4294967296'");
  });
});
