import { describe, it, expect, vi } from 'vitest';
import { makeCostObserver } from '../src/agent/cost-observer.js';
import { log } from '../src/log.js';

describe('makeCostObserver', () => {
  it('case 1: Sonnet 5000/200 tokens → cost ~$0.018, below threshold, no bug', () => {
    const obs = makeCostObserver({ maxCostUsdPerTurn: 0.10 });
    obs.recordUsage('turn-1', 'claude-sonnet-4-6', 5000, 200);
    const detection = obs.finalizeTurn('turn-1');
    expect(detection).toBeNull();
    // cost = (5000 * 3 + 200 * 15) / 1_000_000 = (15000 + 3000) / 1_000_000 = 0.018
    expect(obs.totalSpendUsd).toBeCloseTo(0.018, 4);
  });

  it('case 2: Opus 50000/2000 tokens → cost ~$0.90, above $0.10, fires bug', () => {
    const obs = makeCostObserver({ maxCostUsdPerTurn: 0.10 });
    obs.recordUsage('turn-2', 'claude-opus-4-7', 50000, 2000);
    const detection = obs.finalizeTurn('turn-2');
    expect(detection).not.toBeNull();
    expect(detection?.kind).toBe('agent_cost_per_turn_high');
    // cost = (50000 * 15 + 2000 * 75) / 1_000_000 = (750000 + 150000) / 1_000_000 = 0.90
    expect(detection?.agentContext?.costUsd).toBeCloseTo(0.90, 3);
  });

  it('case 3: multiple upstream calls in one turn aggregated', () => {
    const obs = makeCostObserver({ maxCostUsdPerTurn: 0.10 });
    obs.recordUsage('turn-3', 'claude-sonnet-4-6', 3000, 100);
    obs.recordUsage('turn-3', 'claude-sonnet-4-6', 2000, 100);
    const detection = obs.finalizeTurn('turn-3');
    // total: 5000 input + 200 output = same as case 1
    const totalInput = detection?.agentContext?.tokenCounts?.input;
    const totalOutput = detection?.agentContext?.tokenCounts?.output;
    // combined should be (3000+2000)=5000 input, (100+100)=200 output
    if (detection === null) {
      expect(obs.totalSpendUsd).toBeCloseTo(0.018, 4);
    } else {
      expect(totalInput).toBe(5000);
      expect(totalOutput).toBe(200);
    }
  });

  it('case 4: unknown model id → skipped, warn-once asserted', () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const obs = makeCostObserver({});
    obs.recordUsage('turn-4', 'gpt-unknown-model', 1000, 100);
    const detection = obs.finalizeTurn('turn-4');
    expect(detection).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown model id'),
      expect.objectContaining({ modelId: 'gpt-unknown-model' }),
    );
    // Second call with same model should NOT warn again (warn-once)
    const callCount = warnSpy.mock.calls.length;
    obs.recordUsage('turn-5', 'gpt-unknown-model', 500, 50);
    obs.finalizeTurn('turn-5');
    expect(warnSpy.mock.calls.length).toBe(callCount);
  });

  it('turnsObserved increments per finalizeTurn call', () => {
    const obs = makeCostObserver({});
    obs.recordUsage('t1', 'claude-sonnet-4-6', 100, 10);
    obs.finalizeTurn('t1');
    obs.recordUsage('t2', 'claude-sonnet-4-6', 100, 10);
    obs.finalizeTurn('t2');
    expect(obs.turnsObserved).toBe(2);
  });

  it('finalizeTurn with no recorded usage returns null', () => {
    const obs = makeCostObserver({});
    const detection = obs.finalizeTurn('nonexistent-turn');
    expect(detection).toBeNull();
  });
});
