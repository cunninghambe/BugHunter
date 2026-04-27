// Per-run vision call budget controller + screenshot dedup (§ 4.4, § 7).

import { log } from '../log.js';

// Per-million-token pricing in USD. Used for cost estimation against maxCostUsd.
// Source: Anthropic public pricing (Apr 2026). Update when pricing changes.
const MODEL_PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7': { input: 15.00, output: 75.00 },
};

const DEFAULT_PRICING = { input: 1.00, output: 5.00 };

function pricingFor(model: string): { input: number; output: number } {
  return MODEL_PRICING_USD_PER_MTOK[model] ?? DEFAULT_PRICING;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = pricingFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export type VisionBudget = {
  tryConsume(): boolean;
  tryConsumeHash(hash: string): boolean;
  recordUsage(model: string, inputTokens: number, outputTokens: number): void;
  markAborted(reason: 'auth' | 'transport'): void;
  readonly abortReason: 'auth' | 'transport' | 'cost_cap' | undefined;
  readonly consumed: number;
  readonly remaining: number;
  readonly cap: number;
  readonly costUsd: number;
  readonly costCapUsd: number;
};

export function makeVisionBudget(
  maxCalls: number,
  maxCostUsd: number = 20,
): VisionBudget {
  let consumed = 0;
  let costUsd = 0;
  let exhaustedLogged = false;
  let costExhaustedLogged = false;
  let abortReason: 'auth' | 'transport' | 'cost_cap' | undefined;
  const seenHashes = new Set<string>();

  return {
    tryConsume() {
      if (abortReason !== undefined) return false;
      if (costUsd >= maxCostUsd) {
        if (!costExhaustedLogged) {
          log.info('vision: per-run cost budget exhausted', { capUsd: maxCostUsd, costUsd });
          costExhaustedLogged = true;
        }
        abortReason = 'cost_cap';
        return false;
      }
      if (consumed >= maxCalls) {
        if (!exhaustedLogged) {
          log.info('vision: per-run call budget exhausted', { cap: maxCalls });
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

    recordUsage(model: string, inputTokens: number, outputTokens: number) {
      costUsd += estimateCostUsd(model, inputTokens, outputTokens);
    },

    markAborted(reason: 'auth' | 'transport') {
      abortReason = reason;
    },

    get abortReason() { return abortReason; },
    get consumed() { return consumed; },
    get remaining() { return maxCalls - consumed; },
    get cap() { return maxCalls; },
    get costUsd() { return costUsd; },
    get costCapUsd() { return maxCostUsd; },
  };
}
