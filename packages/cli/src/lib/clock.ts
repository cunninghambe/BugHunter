// CLI-side clock abstraction for --frozen-clock mode.
// OQ-1 (conservative): browser-side polyfill is a stub until V23 lands.
// OQ-5: warn on stderr when only some determinism flags are set.

import type { RunOptions } from '../cli/run.js';

export type Clock =
  | { kind: 'wall' }
  | { kind: 'frozen'; isoTime: string; ms: number };

/**
 * Build a Clock from RunOptions.
 * Throws with the canonical error message if frozenClock is syntactically invalid.
 */
export function makeClock(opts: Pick<RunOptions, 'frozenClock'>): Clock {
  if (opts.frozenClock === undefined) return { kind: 'wall' };
  const ms = Date.parse(opts.frozenClock);
  if (Number.isNaN(ms)) {
    throw new Error(`--frozen-clock: invalid ISO 8601: '${opts.frozenClock}'`);
  }
  return { kind: 'frozen', isoTime: new Date(ms).toISOString(), ms };
}

/** Return the current ISO 8601 timestamp, frozen when clock.kind === 'frozen'. */
export function nowIso(clock: Clock): string {
  return clock.kind === 'frozen' ? clock.isoTime : new Date().toISOString();
}

/** Return current epoch-ms, frozen when clock.kind === 'frozen'. */
export function nowMs(clock: Clock): number {
  return clock.kind === 'frozen' ? clock.ms : Date.now();
}

/**
 * V23 stub: install a frozen-clock polyfill into the browser page.
 * Real implementation pending V23 landing.  No-op for now (OQ-1).
 */
export async function installFrozenClock(
  _evaluate: (script: string) => Promise<unknown>,
  _clock: Clock,
): Promise<void> {
  // V23 will inject Date.now / new Date() overrides here.
  // Keeping the call site wired so V23 only needs to fill this body.
}
