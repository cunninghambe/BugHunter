// v0.43: Per-run LLM-of-output call budget for agent hallucination checks.
// Separate from VisionBudget — noisy hallucination runs must not exhaust the v0.4 visual budget.

import { log } from '../log.js';

export type AgentBudget = {
  tryConsume(): boolean;
  recordCost(costUsd: number): void;
  markAborted(reason: 'auth' | 'transport'): void;
  readonly abortReason: 'auth' | 'transport' | 'budget' | undefined;
  readonly consumed: number;
  readonly cap: number;
  readonly totalCostUsd: number;
};

export function makeAgentBudget(maxLlmOfOutputCalls: number): AgentBudget {
  let consumed = 0;
  let totalCostUsd = 0;
  let exhaustedLogged = false;
  let abortReason: 'auth' | 'transport' | 'budget' | undefined;

  return {
    tryConsume() {
      if (abortReason !== undefined) return false;
      if (consumed >= maxLlmOfOutputCalls) {
        if (!exhaustedLogged) {
          log.info('agent: per-run LLM-of-output budget exhausted', { cap: maxLlmOfOutputCalls });
          exhaustedLogged = true;
        }
        abortReason = 'budget';
        return false;
      }
      consumed++;
      return true;
    },

    recordCost(costUsd: number) {
      totalCostUsd += costUsd;
    },

    markAborted(reason: 'auth' | 'transport') {
      abortReason = reason;
    },

    get abortReason() { return abortReason; },
    get consumed() { return consumed; },
    get cap() { return maxLlmOfOutputCalls; },
    get totalCostUsd() { return totalCostUsd; },
  };
}
