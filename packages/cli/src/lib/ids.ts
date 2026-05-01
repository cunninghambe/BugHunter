// Seeded id factory seam — replace bare cuid2 import across the codebase.
//
// When a seed is active (set by run.ts via setIdFactory), createId() produces
// fully deterministic cuid2 values.  When no seed is set, the default cuid2
// factory (wall-clock, OS-entropy) is used.
//
// OQ-3 (conservative): runId under --seed is prefixed "det-<seed>-<seeded-cuid>"
// to avoid collision with a previous run that used the same seed.
//
// EC-9: cuid2 init() still uses Date.now() internally for its time component.
// We pass a seeded random + fixed counter start so the per-call entropy is fully
// determined even if the internal timestamp component is constant.  Verified by
// the 1000-call uniqueness test in ids.test.ts.

import { createId as cuid2CreateId, init as cuid2Init } from '@paralleldrive/cuid2';
import { mulberry32 } from './rng.js';

type IdFactory = () => string;

// Module-level singleton — smallest possible global (one per process).
let _factory: IdFactory = cuid2CreateId;

/**
 * Install a seeded id factory for the duration of a run.
 * Call once at run-start (in runCommand) with the parsed seed.
 * The factory is derived from mulberry32 so it is fully deterministic.
 */
export function setIdFactory(seed: number): void {
  const rng = mulberry32(seed);
  // counter starts at 0 per spec §3.1 to eliminate one entropy round.
  const counter = createCounter(0);
  _factory = cuid2Init({
    random: rng,
    counter,
    // Fixed fingerprint suppresses host-env sampling (spec §3.1).
    fingerprint: 'bh-deterministic',
  });
}

/**
 * Reset the factory to the default (unseeded) cuid2.
 * Called in tests to isolate state between test cases.
 */
export function resetIdFactory(): void {
  _factory = cuid2CreateId;
}

/**
 * Project-wide id generator.  Import this instead of '@paralleldrive/cuid2'.
 * Returns seeded ids when --seed is active, default ids otherwise.
 */
export function createId(): string {
  return _factory();
}

/**
 * Create a seeded RNG instance from a given seed.
 * Exposed so callers that need raw random numbers (e.g. auth-flow temp passwords)
 * can use the same PRNG as the id factory.
 */
export function makeSeededRng(seed: number): () => number {
  return mulberry32(seed);
}

// --- internal helpers ---

function createCounter(start: number): () => number {
  let n = start;
  return () => n++;
}
