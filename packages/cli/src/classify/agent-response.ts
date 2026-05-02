// v0.43: LLM-of-output hallucination classifier for agent response verification.
// Follows the same shape as vision.ts: pure async function, returns BugDetection[], no fs writes.

import type { BugDetection } from '../types.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import { VisionApiError } from '../adapters/vision-client.js';
import type { AgentBudget } from '../agent/agent-budget.js';
import { log } from '../log.js';

const AGENT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFIER_MODEL = 'claude-sonnet-4-6';
const MIN_ASSISTANT_TEXT_LENGTH = 20;
const MAX_ASSISTANT_TEXT_CHARS = 8_000;
const MAX_SOURCES_CHARS = 16_000;
const MAX_DESCRIPTION_CHARS = 500;

// v1 prompt template — exported so tests can assert exact content.
export const AGENT_HALLUCINATION_PROMPT_TEMPLATE_V1 = `You are a verification model checking whether a chat assistant's reply is supported
by the source data the agent had access to.

ASSISTANT REPLY (verbatim):
<<<{{assistantText}}>>>

SOURCE DATA AVAILABLE TO THE AGENT (verbatim, may be truncated at 16 KB):
<<<{{sources}}>>>

TASK:
Identify any factual claim in the assistant reply that is NOT supported by the source data.

Rules:
- Pleasantries ("Sure!", "Here is what I found:") are NOT claims.
- Common-knowledge statements that any general assistant would know ("the sky is blue") are NOT
  hallucinations even if absent from the source. Mark only DOMAIN-SPECIFIC claims.
- A claim is "supported" if the source contains a literal or unambiguously paraphrased equivalent.
- A claim is "unsupported" only if the source clearly does NOT contain it AND no reasonable
  interpretation of the source provides it.
- If the source data is empty, return supported: true with confidence: low (we cannot verify).

Return STRICT JSON, no prose, no markdown fences:
{
  "supported": true | false,
  "confidence": "high" | "medium" | "low",
  "claim": "<verbatim claim text from the reply, or empty>",
  "evidence": "<snippet from source if supported; or 'absent in source' if not>"
}`;

type VerifierResponse = {
  supported: boolean;
  confidence: 'high' | 'medium' | 'low';
  claim: string;
  evidence: string;
};

export type ClassifyAgentResponseInput = {
  screenshotPath: string;
  assistantText: string;
  sources: string;
  modelId: string;
  turnId: string;
  client: VisionClientInterface;
  budget: AgentBudget;
  verifierModel?: string;
};

export async function classifyAgentResponseHallucination(
  input: ClassifyAgentResponseInput,
): Promise<BugDetection[]> {
  if (input.assistantText.length < MIN_ASSISTANT_TEXT_LENGTH) {
    log.info('agent: hallucination check skipped — assistant text too short', { turnId: input.turnId });
    return [];
  }
  if (input.sources.length === 0) {
    log.info('agent: hallucination check skipped — no source data captured', { turnId: input.turnId });
    return [];
  }
  if (!input.budget.tryConsume()) return [];

  const assistantText = input.assistantText.slice(0, MAX_ASSISTANT_TEXT_CHARS);
  if (assistantText.length < input.assistantText.length) {
    log.info('agent: assistantText truncated for hallucination check', { turnId: input.turnId });
  }
  const sources = input.sources.slice(0, MAX_SOURCES_CHARS);

  const promptText = AGENT_HALLUCINATION_PROMPT_TEMPLATE_V1
    .replace('{{assistantText}}', assistantText)
    .replace('{{sources}}', sources);

  const verifierModel = input.verifierModel ?? DEFAULT_VERIFIER_MODEL;

  let rawText: string;
  try {
    if (input.client.classifyText === undefined) {
      log.warn('agent: vision client does not support classifyText; hallucination check skipped', { turnId: input.turnId });
      return [];
    }
    const response = await input.client.classifyText({
      promptText,
      model: verifierModel,
      timeoutMs: AGENT_CALL_TIMEOUT_MS,
    });
    rawText = response.rawText;
    if (response.usage !== undefined) {
      const costUsd = (response.usage.inputTokens * 3 + response.usage.outputTokens * 15) / 1_000_000;
      input.budget.recordCost(costUsd);
    }
  } catch (err) {
    if (err instanceof VisionApiError) {
      log.warn(`agent: hallucination verifier API error (${err.kind})`, { message: err.message, turnId: input.turnId });
    } else {
      log.warn('agent: hallucination verifier unexpected error', { message: String(err), turnId: input.turnId });
    }
    return [];
  }

  const verdict = parseVerifierResponse(rawText, input.turnId);
  if (verdict === null) return [];

  if (verdict.supported !== false || verdict.confidence !== 'high') {
    if (!verdict.supported && verdict.confidence !== 'high') {
      log.info('agent: low-confidence hallucination signal, not firing', { turnId: input.turnId, confidence: verdict.confidence });
    }
    return [];
  }

  const claim = verdict.claim.slice(0, MAX_DESCRIPTION_CHARS);
  const evidence = verdict.evidence.slice(0, MAX_DESCRIPTION_CHARS);

  return [{
    kind: 'agent_response_hallucinated',
    rootCause: `Agent response contains unsupported claim: "${claim}"`,
    screenshotPath: input.screenshotPath,
    agentContext: {
      turnId: input.turnId,
      modelId: input.modelId,
      proof: { kind: 'unsupported_claim', claim, evidence },
    },
  }];
}

function parseVerifierResponse(rawText: string, turnId: string): VerifierResponse | null {
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    log.warn('agent: hallucination verifier malformed JSON', { preview: rawText.slice(0, 200), turnId });
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    log.warn('agent: hallucination verifier malformed response structure', { preview: rawText.slice(0, 200), turnId });
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['supported'] !== 'boolean') {
    log.warn('agent: hallucination verifier missing supported field', { turnId });
    return null;
  }

  const confidence = obj['confidence'];
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    log.warn('agent: hallucination verifier invalid confidence', { confidence, turnId });
    return null;
  }

  return {
    supported: obj['supported'],
    confidence,
    claim: typeof obj['claim'] === 'string' ? obj['claim'] : '',
    evidence: typeof obj['evidence'] === 'string' ? obj['evidence'] : '',
  };
}
