// v0.43 cluster signature + KIND_PRIORITY tests for agentic-app detection kinds (§ 12.5, 12.6)
import { describe, it, expect } from 'vitest';
import { clusterSignature } from '../src/cluster/signature.js';
import { runClassify } from '../src/phases/classify.js';
import type { BugDetection, TestResult } from '../src/types.js';

function makeTestResult(bugs: BugDetection[]): TestResult {
  return { testId: 'test-agent', occurrenceId: 'occ-agent', passed: false, bugs, durationMs: 100 };
}

// --- cluster signature tests ---

describe('clusterSignature — v0.43 agentic kinds', () => {
  it('agent_response_hallucinated: deterministic signature per endpoint + claim', () => {
    const d: BugDetection = {
      kind: 'agent_response_hallucinated',
      rootCause: 'Unsupported claim',
      endpoint: 'POST /api/chat',
      agentContext: {
        turnId: 'turn-1',
        proof: { kind: 'unsupported_claim', claim: 'Revenue was $1M', evidence: 'absent' },
      },
    };
    const sig1 = clusterSignature(d);
    const sig2 = clusterSignature(d);
    expect(sig1).toBe(sig2);
    expect(sig1).toContain('agent_response_hallucinated');
  });

  it('agent_action_timeout: deterministic signature per endpoint', () => {
    const d: BugDetection = {
      kind: 'agent_action_timeout',
      rootCause: 'Turn timed out',
      endpoint: 'POST /api/chat',
      agentContext: { turnId: 'turn-2', latencyMs: 35000 },
    };
    expect(clusterSignature(d)).toBe('agent_action_timeout|POST /api/chat');
  });

  it('prompt_injection_executed: deterministic signature per endpoint + param + variant', () => {
    const d: BugDetection = {
      kind: 'prompt_injection_executed',
      rootCause: 'Injection succeeded',
      endpoint: 'POST /api/chat',
      injectionContext: { paramName: 'message', variant: 'system_override_simple', nonce: 'abc', proof: 'instruction_override', evidence: 'BUGHUNTER_abc' },
    };
    const sig = clusterSignature(d);
    expect(sig).toContain('prompt_injection_executed');
    expect(sig).toContain('message');
    expect(sig).toContain('system_override_simple');
  });

  it('streaming_response_truncated: deterministic signature per endpoint + reason', () => {
    const d: BugDetection = {
      kind: 'streaming_response_truncated',
      rootCause: 'Stream truncated',
      endpoint: 'http://localhost/api/chat',
      agentContext: {
        turnId: 'stream-1',
        streamId: 'stream-1',
        proof: { kind: 'truncated', reason: 'connection_closed', lastChunkSnippet: 'partial', chunkCount: 3, durationMs: 2000 },
      },
    };
    const sig = clusterSignature(d);
    expect(sig).toContain('streaming_response_truncated');
    expect(sig).toContain('connection_closed');
  });

  it('tool_call_failure_unhandled: deterministic signature per tool endpoint', () => {
    const d: BugDetection = {
      kind: 'tool_call_failure_unhandled',
      rootCause: 'Tool failed silently',
      agentContext: {
        turnId: 'turn-3',
        proof: { kind: 'silent_failure', toolEndpoint: '/api/tool/search', status: 500, settleWaitMs: 5000 },
      },
    };
    const sig = clusterSignature(d);
    expect(sig).toContain('tool_call_failure_unhandled');
    expect(sig).toContain('/api/tool/search');
  });

  it('agent_cost_per_turn_high: deterministic signature per endpoint + modelId', () => {
    const d: BugDetection = {
      kind: 'agent_cost_per_turn_high',
      rootCause: 'Turn too expensive',
      endpoint: 'POST /api/chat',
      agentContext: { turnId: 'turn-4', modelId: 'claude-opus-4-7', costUsd: 0.95 },
    };
    const sig = clusterSignature(d);
    expect(sig).toContain('agent_cost_per_turn_high');
    expect(sig).toContain('claude-opus-4-7');
  });

  it('dedup: same detection produces identical signature across pages', () => {
    const d: BugDetection = {
      kind: 'agent_action_timeout',
      rootCause: 'Timeout',
      endpoint: 'POST /api/chat',
      agentContext: { turnId: 'turn-5', latencyMs: 40000 },
    };
    expect(clusterSignature(d)).toBe(clusterSignature(d));
  });
});

// --- KIND_PRIORITY tests ---

describe('KIND_PRIORITY — v0.43 ordering (§ 8.2 / 12.6)', () => {
  it('agent_response_hallucinated + visual_anomaly → canonical is hallucinated', () => {
    const bugs: BugDetection[] = [
      { kind: 'visual_anomaly', rootCause: 'blank area', visualCategory: 'state', visualSeverity: 'major' },
      { kind: 'agent_response_hallucinated', rootCause: 'unsupported claim', agentContext: { turnId: 't' } },
    ];
    const { bugs: classified } = runClassify([makeTestResult(bugs)]);
    expect(classified[0]?.detection.kind).toBe('agent_response_hallucinated');
  });

  it('agent_action_timeout + missing_state_change → canonical is missing_state_change', () => {
    const bugs: BugDetection[] = [
      { kind: 'agent_action_timeout', rootCause: 'timeout', agentContext: { turnId: 't' } },
      { kind: 'missing_state_change', rootCause: 'no change' },
    ];
    const { bugs: classified } = runClassify([makeTestResult(bugs)]);
    expect(classified[0]?.detection.kind).toBe('missing_state_change');
  });

  it('tool_call_failure_unhandled + dom_error_text → canonical is dom_error_text', () => {
    const bugs: BugDetection[] = [
      { kind: 'tool_call_failure_unhandled', rootCause: 'silent fail', agentContext: { turnId: 't' } },
      { kind: 'dom_error_text', rootCause: 'Error shown in DOM' },
    ];
    const { bugs: classified } = runClassify([makeTestResult(bugs)]);
    expect(classified[0]?.detection.kind).toBe('dom_error_text');
  });
});
