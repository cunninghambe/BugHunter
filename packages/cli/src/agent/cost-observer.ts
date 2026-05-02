// v0.43: Per-turn token/cost aggregator for agent cost detection.

import type { BugDetection, AgentConfig } from '../types.js';
import { computeTurnCost } from './cost-pricing.js';
import { log } from '../log.js';

const DEFAULT_MAX_COST_USD_PER_TURN = 0.10;

type TurnAccumulator = {
  turnId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
};

export type CostObserver = {
  /** Record token usage for a turn. Body `usage` wins over header tokens when both supplied. */
  recordUsage(turnId: string, modelId: string, inputTokens: number, outputTokens: number): void;
  /** Finalize a turn and return a detection if cost exceeds threshold. */
  finalizeTurn(turnId: string): BugDetection | null;
  readonly turnsObserved: number;
  readonly totalSpendUsd: number;
};

export function makeCostObserver(cfg: AgentConfig): CostObserver {
  const maxCostUsdPerTurn = cfg.maxCostUsdPerTurn ?? DEFAULT_MAX_COST_USD_PER_TURN;
  const warnedModels = new Set<string>();
  const turns = new Map<string, TurnAccumulator>();
  let turnsObserved = 0;
  let totalSpendUsd = 0;

  return {
    recordUsage(turnId: string, modelId: string, inputTokens: number, outputTokens: number) {
      const existing = turns.get(turnId);
      if (existing === undefined) {
        turns.set(turnId, { turnId, modelId, inputTokens, outputTokens });
      } else {
        existing.inputTokens += inputTokens;
        existing.outputTokens += outputTokens;
        // Prefer the first modelId recorded; don't overwrite with 'unknown'
        if (existing.modelId === 'unknown' && modelId !== 'unknown') {
          existing.modelId = modelId;
        }
      }
    },

    finalizeTurn(turnId: string): BugDetection | null {
      const acc = turns.get(turnId);
      turns.delete(turnId);
      if (acc === undefined) return null;
      turnsObserved++;

      const costUsd = computeTurnCost(acc.modelId, acc.inputTokens, acc.outputTokens);
      if (costUsd === undefined) {
        if (!warnedModels.has(acc.modelId)) {
          log.warn('agent: unknown model id; cost detection skipped', { modelId: acc.modelId });
          warnedModels.add(acc.modelId);
        }
        return null;
      }

      totalSpendUsd += costUsd;
      if (costUsd <= maxCostUsdPerTurn) return null;

      return {
        kind: 'agent_cost_per_turn_high',
        rootCause: `Agent turn cost $${costUsd.toFixed(4)} exceeds threshold $${maxCostUsdPerTurn} (model: ${acc.modelId})`,
        agentContext: {
          turnId: acc.turnId,
          modelId: acc.modelId,
          costUsd,
          tokenCounts: { input: acc.inputTokens, output: acc.outputTokens },
        },
      };
    },

    get turnsObserved() { return turnsObserved; },
    get totalSpendUsd() { return totalSpendUsd; },
  };
}
