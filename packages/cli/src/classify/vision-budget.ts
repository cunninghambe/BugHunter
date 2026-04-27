// Per-run vision call budget controller + screenshot dedup (§ 4.4, § 7).

import { log } from '../log.js';

export type VisionBudget = {
  /** Returns true if a call slot is available and not aborted; consumes a slot if so. */
  tryConsume(): boolean;
  /** Try-consume for a known screenshot hash. Returns false if hash already seen. */
  tryConsumeHash(hash: string): boolean;
  /** Signal an API auth or transport abort; all subsequent tryConsume calls return false. */
  markAborted(reason: 'auth' | 'transport'): void;
  readonly abortReason: 'auth' | 'transport' | undefined;
  readonly consumed: number;
  readonly remaining: number;
  readonly cap: number;
};

export function makeVisionBudget(maxCalls: number): VisionBudget {
  let consumed = 0;
  let exhaustedLogged = false;
  let abortReason: 'auth' | 'transport' | undefined;
  const seenHashes = new Set<string>();

  return {
    tryConsume() {
      if (abortReason !== undefined) return false;
      if (consumed >= maxCalls) {
        if (!exhaustedLogged) {
          log.info('vision: per-run budget exhausted', { cap: maxCalls });
          exhaustedLogged = true;
        }
        return false;
      }
      consumed++;
      return true;
    },

    tryConsumeHash(hash: string) {
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    },

    markAborted(reason: 'auth' | 'transport') {
      abortReason = reason;
    },

    get abortReason() { return abortReason; },
    get consumed() { return consumed; },
    get remaining() { return maxCalls - consumed; },
    get cap() { return maxCalls; },
  };
}
