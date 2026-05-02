// v0.43: Per-model token pricing for agent cost detection.
// USD per 1M tokens. Update when providers change pricing.

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6':  { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':   { input: 0.25,  output: 1.25  },
  'claude-opus-4-7':    { input: 15.00, output: 75.00 },
  'gpt-4o':             { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':        { input: 0.15,  output: 0.60  },
};

/** Returns undefined when modelId is unknown (caller logs warn once). */
export function pricingForModel(modelId: string): { input: number; output: number } | undefined {
  return MODEL_PRICING[modelId];
}

export function computeTurnCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const pricing = pricingForModel(modelId);
  if (pricing === undefined) return undefined;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
