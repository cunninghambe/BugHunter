import { describe, it, expect } from 'vitest';
import { computeConsensus, defaultThreshold } from './consensus.js';
import type { BugSignal } from '../../types.js';

function present(confidence: 'high' | 'low' = 'high'): BugSignal {
  return { present: true, confidence, reason: 'test' };
}
function absent(confidence: 'high' | 'low' = 'high'): BugSignal {
  return { present: false, confidence, reason: 'test' };
}
function inconclusive(): BugSignal {
  return { present: false, confidence: 'low', reason: 'low confidence absent' };
}

describe('computeConsensus', () => {
  it('bad when >= threshold present votes', () => {
    const result = computeConsensus([present(), absent(), present()], 2, present());
    expect(result.verdict.kind).toBe('bad');
    expect(result.votes.present).toBe(2);
    expect(result.votes.absent).toBe(1);
  });

  it('good when >= threshold high-confidence absent votes', () => {
    const result = computeConsensus([absent(), absent(), present()], 2, present());
    expect(result.verdict.kind).toBe('good');
    expect(result.votes.absent).toBe(2);
    expect(result.votes.present).toBe(1);
  });

  it('skip(flaky_on_commit) when mixed below threshold', () => {
    const result = computeConsensus([present(), absent(), inconclusive()], 2, present());
    expect(result.verdict.kind).toBe('skip');
    if (result.verdict.kind === 'skip') {
      expect(result.verdict.reason).toBe('flaky_on_commit');
    }
  });

  it('skip(replay_inconclusive) when all inconclusive', () => {
    const result = computeConsensus([inconclusive(), inconclusive(), inconclusive()], 2, undefined);
    expect(result.verdict.kind).toBe('skip');
    if (result.verdict.kind === 'skip') {
      expect(result.verdict.reason).toBe('replay_inconclusive');
    }
  });

  it('bad with single run (strict mode)', () => {
    const result = computeConsensus([present()], 1, present());
    expect(result.verdict.kind).toBe('bad');
  });

  it('good with single run (strict mode)', () => {
    const result = computeConsensus([absent()], 1, undefined);
    expect(result.verdict.kind).toBe('good');
  });
});

describe('defaultThreshold', () => {
  it('ceil(n/2)', () => {
    expect(defaultThreshold(1)).toBe(1);
    expect(defaultThreshold(2)).toBe(1);
    expect(defaultThreshold(3)).toBe(2);
    expect(defaultThreshold(5)).toBe(3);
  });
});
