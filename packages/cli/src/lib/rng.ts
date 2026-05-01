// Deterministic PRNG for --seed mode.
// Uses mulberry32 (32-bit state, 32-bit output, period 2^32).
// Zero external dependencies. Not cryptographic — seed-reproducibility only.

/**
 * Create a mulberry32 PRNG with the given 32-bit seed.
 * Returns a function () => number in [0, 1), matching the Math.random signature.
 *
 * OQ-10 (EC-11): accepts any 32-bit unsigned integer.
 * Caller is responsible for range validation.
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Validate a CLI-supplied seed string.
 * Returns the parsed integer or throws with the canonical error message.
 */
export function parseSeed(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF) {
    throw new Error(`--seed must be a 32-bit non-negative integer; got '${raw}'`);
  }
  return n;
}
