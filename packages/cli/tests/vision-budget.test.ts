import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeVisionBudget } from '../src/classify/vision-budget.js';
import { log } from '../src/log.js';

describe('VisionBudget', () => {
  it('case 1: tryConsume returns true for the first cap calls; consumed === cap after', () => {
    const budget = makeVisionBudget(3);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.consumed).toBe(3);
    expect(budget.remaining).toBe(0);
  });

  it('case 2: tryConsume returns false on call cap+1; consumed stays at cap', () => {
    const budget = makeVisionBudget(2);
    budget.tryConsume();
    budget.tryConsume();
    expect(budget.tryConsume()).toBe(false);
    expect(budget.consumed).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it('case 3: markAborted makes all subsequent tryConsume return false', () => {
    const budget = makeVisionBudget(100);
    expect(budget.tryConsume()).toBe(true);
    budget.markAborted('auth');
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.abortReason).toBe('auth');
  });

  it('case 4: "budget exhausted" log emitted exactly once across multiple calls past cap', () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const budget = makeVisionBudget(1);
    budget.tryConsume(); // uses the one slot
    // Call 5 more times past cap
    for (let i = 0; i < 5; i++) budget.tryConsume();
    const exhaustedCalls = infoSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('budget exhausted')
    );
    expect(exhaustedCalls).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('tryConsumeHash: returns true for new hash, false for duplicate', () => {
    const budget = makeVisionBudget(100);
    expect(budget.tryConsumeHash('abc123')).toBe(true);
    expect(budget.tryConsumeHash('abc123')).toBe(false);
    expect(budget.tryConsumeHash('def456')).toBe(true);
  });

  it('cap property reflects maxCalls', () => {
    const budget = makeVisionBudget(42);
    expect(budget.cap).toBe(42);
  });
});
