// v0.35: consensus voting for bisect per-commit verdicts.
// Maps vote tallies to BisectVerdict.

import type { BisectVerdict, BugSignal } from '../../types.js';

export type ConsensusVotes = {
  present: number;
  absent: number;
  inconclusive: number;
};

export type ConsensusResult = {
  verdict: BisectVerdict;
  votes: ConsensusVotes;
};

/**
 * Compute the bisect verdict from a set of per-replay signals.
 * If >= threshold signals are 'present' (any confidence) → bad.
 * If >= threshold signals are 'absent' (high confidence) → good.
 * Otherwise → skip with 'flaky_on_commit' or 'replay_inconclusive'.
 */
export function computeConsensus(
  signals: BugSignal[],
  threshold: number,
  worstSignal: BugSignal | undefined,
): ConsensusResult {
  const votes: ConsensusVotes = { present: 0, absent: 0, inconclusive: 0 };

  for (const sig of signals) {
    if (sig.present) {
      votes.present++;
    } else if (sig.confidence === 'high') {
      votes.absent++;
    } else {
      votes.inconclusive++;
    }
  }

  if (votes.present >= threshold) {
    const firstPresent = signals.find(s => s.present);
    const signal: BugSignal = worstSignal ?? firstPresent ?? { present: true, confidence: 'high', reason: 'consensus' };
    return { verdict: { kind: 'bad', signal }, votes };
  }

  if (votes.absent >= threshold) {
    return { verdict: { kind: 'good' }, votes };
  }

  if (votes.present === 0 && votes.absent === 0) {
    return { verdict: { kind: 'skip', reason: 'replay_inconclusive' }, votes };
  }

  return { verdict: { kind: 'skip', reason: 'flaky_on_commit' }, votes };
}

/** Compute the consensus threshold from runs count. Default: ceil(runs/2). */
export function defaultThreshold(runs: number): number {
  return Math.ceil(runs / 2);
}
