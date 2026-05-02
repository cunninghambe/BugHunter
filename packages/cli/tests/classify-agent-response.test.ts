import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { classifyAgentResponseHallucination, AGENT_HALLUCINATION_PROMPT_TEMPLATE_V1 } from '../src/classify/agent-response.js';
import { VisionApiError } from '../src/adapters/vision-client.js';
import type { VisionClientInterface } from '../src/adapters/vision-client.js';
import { makeAgentBudget } from '../src/agent/agent-budget.js';
import { log } from '../src/log.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/agent-hallucination-prompt-v1.txt');

// A screenshot path that doesn't need to exist for unit tests
const FAKE_SCREENSHOT = '/tmp/agent-test-screenshot.png';

function makeClient(rawText: string): VisionClientInterface {
  return {
    classify: vi.fn(),
    classifyText: vi.fn().mockResolvedValue({ rawText }),
  };
}

function makeThrowingClient(err: Error): VisionClientInterface {
  return {
    classify: vi.fn(),
    classifyText: vi.fn().mockRejectedValue(err),
  };
}

function makeBudget(cap = 50) {
  return makeAgentBudget(cap);
}

const BASE_INPUT = {
  screenshotPath: FAKE_SCREENSHOT,
  assistantText: 'The Q4 revenue was $1.2 million according to the financial report.',
  sources: 'Q3 revenue: $0.9 million. Q4 revenue: $0.95 million.',
  modelId: 'claude-sonnet-4-6',
  turnId: 'turn-001',
};

describe('classifyAgentResponseHallucination', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('case 1: verifier returns supported:false, confidence:high → one BugDetection', async () => {
    const raw = JSON.stringify({ supported: false, confidence: 'high', claim: 'Q4 revenue was $1.2 million', evidence: 'absent in source' });
    const client = makeClient(raw);
    const budget = makeBudget();
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget });
    expect(detections).toHaveLength(1);
    const d = detections[0]!;
    expect(d.kind).toBe('agent_response_hallucinated');
    expect(d.agentContext?.proof?.kind).toBe('unsupported_claim');
    if (d.agentContext?.proof?.kind === 'unsupported_claim') {
      expect(d.agentContext.proof.claim).toContain('Q4 revenue');
    }
  });

  it('case 2: verifier returns supported:false, confidence:medium → empty array (below threshold)', async () => {
    const raw = JSON.stringify({ supported: false, confidence: 'medium', claim: 'some claim', evidence: 'absent' });
    const client = makeClient(raw);
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget: makeBudget() });
    expect(detections).toHaveLength(0);
  });

  it('case 3: verifier returns supported:true → empty array', async () => {
    const raw = JSON.stringify({ supported: true, confidence: 'high', claim: '', evidence: 'Q4 revenue: $0.95 million' });
    const client = makeClient(raw);
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget: makeBudget() });
    expect(detections).toHaveLength(0);
  });

  it('case 4: assistantText length < 20 → skip with log.info, empty array', async () => {
    const warnSpy = vi.spyOn(log, 'info');
    const client = makeClient('{}');
    const detections = await classifyAgentResponseHallucination({
      ...BASE_INPUT,
      assistantText: 'Short',
      client,
      budget: makeBudget(),
    });
    expect(detections).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too short'), expect.anything());
  });

  it('case 5: sources empty → skip with log.info, empty array', async () => {
    const infoSpy = vi.spyOn(log, 'info');
    const client = makeClient('{}');
    const detections = await classifyAgentResponseHallucination({
      ...BASE_INPUT,
      sources: '',
      client,
      budget: makeBudget(),
    });
    expect(detections).toHaveLength(0);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('no source data'), expect.anything());
  });

  it('case 6: verifier throws VisionApiError(timeout) → empty array, log.warn called', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const client = makeThrowingClient(new VisionApiError('timeout', 'timed out'));
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget: makeBudget() });
    expect(detections).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('timeout'), expect.anything());
  });

  it('case 7: verifier returns malformed JSON → empty array, log.warn called', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const client = makeClient('not-json');
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget: makeBudget() });
    expect(detections).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed JSON'), expect.anything());
  });

  it('case 8: claim exceeding 500 chars is truncated', async () => {
    const longClaim = 'A'.repeat(600);
    const raw = JSON.stringify({ supported: false, confidence: 'high', claim: longClaim, evidence: 'absent in source' });
    const client = makeClient(raw);
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget: makeBudget() });
    expect(detections).toHaveLength(1);
    const proof = detections[0]!.agentContext?.proof;
    if (proof?.kind === 'unsupported_claim') {
      expect(proof.claim.length).toBeLessThanOrEqual(500);
    }
  });

  it('case 9: AGENT_HALLUCINATION_PROMPT_TEMPLATE_V1 matches fixture file', () => {
    const fixture = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    expect(AGENT_HALLUCINATION_PROMPT_TEMPLATE_V1).toBe(fixture);
  });

  it('budget cap honoured: calls beyond cap are skipped', async () => {
    const raw = JSON.stringify({ supported: false, confidence: 'high', claim: 'claim', evidence: 'absent' });
    const client = makeClient(raw);
    const budget = makeBudget(2);
    await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget });
    await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget });
    // Third call: budget exhausted
    const detections = await classifyAgentResponseHallucination({ ...BASE_INPUT, client, budget });
    expect(detections).toHaveLength(0);
    expect(budget.consumed).toBe(2);
  });
});
