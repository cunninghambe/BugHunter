// Unit tests for dataIntegrity/evaluator.ts — one happy + one violated per BugKind.
// Mocks runSeedHook so no actual HTTP/shell calls are made.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { snapshotInvariantsBefore, evaluateInvariantsAfter } from '../evaluator.js';
import type { EvaluatorContext, ActionResult } from '../evaluator.js';
import type { DataIntegrityInvariant, InvariantQuery, TestCase } from '../../types.js';

// Mock the seed runner to avoid actual I/O
vi.mock('../../seed/runner.js', () => ({
  runSeedHook: vi.fn(),
}));

import { runSeedHook } from '../../seed/runner.js';
const mockRunSeedHook = vi.mocked(runSeedHook);

const ctx: EvaluatorContext = {
  projectDir: '/tmp/test',
  appBaseUrl: 'http://localhost:3000',
  runId: 'run-test-1',
};

const tc: TestCase = {
  id: 'action-delete-user',
  runId: 'run-test-1',
  role: 'admin',
  page: '/api/users/42',
  palette: 'happy',
  action: { kind: 'submit', via: 'api', expectedOutcome: 'success', palette: 'happy' },
  expectedOutcome: 'success',
};

const actionResult: ActionResult = {
  requestBody: JSON.stringify({ id: '42' }),
  responseBody: JSON.stringify({ id: '42', deleted: true }),
  status: 200,
  requestHeaders: {},
  url: 'http://localhost:3000/api/users/42',
  method: 'POST',
};

// A well-formed InvariantQuery using http
const checkQuery: InvariantQuery['query'] = {
  kind: 'http',
  url: 'http://localhost:3000/api/check',
  method: 'GET',
};

function afterPhase(op: string, value: unknown, jsonPath?: string): InvariantQuery {
  return {
    query: checkQuery,
    parse: 'json',
    expect: { op: op as 'equals', value, ...(jsonPath !== undefined ? { jsonPath } : {}) },
  };
}

function makeInvariant(overrides: Partial<DataIntegrityInvariant>): DataIntegrityInvariant {
  return {
    name: 'test-invariant',
    bugKind: 'data_integrity_orphan',
    appliesTo: {},
    after: afterPhase('lengthEquals', 0),
    ...overrides,
  };
}

const baseExec = { hookKind: 'http' as const, lifecyclePoint: 'afterEach' as const, durationMs: 10, description: 'test' };

function mockQueryJson(data: unknown) {
  mockRunSeedHook.mockResolvedValue({ ...baseExec, ok: true, output: JSON.stringify(data) });
}

function mockQueryText(text: string) {
  mockRunSeedHook.mockResolvedValue({ ...baseExec, ok: true, output: text });
}

function mockQueryFail() {
  mockRunSeedHook.mockResolvedValue({ ...baseExec, ok: false, output: undefined });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// snapshotInvariantsBefore
// ---------------------------------------------------------------------------

describe('snapshotInvariantsBefore', () => {
  it('returns pending snapshot with empty beforeStore when no before clause', async () => {
    const inv = makeInvariant({ before: undefined });
    const pending = await snapshotInvariantsBefore([inv], tc, ctx);
    expect(pending).toHaveLength(1);
    expect(pending[0].beforeStore).toEqual({});
    expect(mockRunSeedHook).not.toHaveBeenCalled();
  });

  it('runs before query and stores result in beforeStore', async () => {
    mockQueryJson({ count: 5 });
    const inv = makeInvariant({
      before: {
        query: checkQuery,
        parse: 'json',
        store: { count: 'count' },
      },
    });
    const pending = await snapshotInvariantsBefore([inv], tc, ctx);
    expect(mockRunSeedHook).toHaveBeenCalledTimes(1);
    expect(pending[0].beforeStore).toMatchObject({ count: 5 });
  });
});

// ---------------------------------------------------------------------------
// data_integrity_orphan
// ---------------------------------------------------------------------------

describe('data_integrity_orphan — happy path', () => {
  it('passes when orphan query returns empty array', async () => {
    mockQueryJson([]);
    const inv = makeInvariant({
      bugKind: 'data_integrity_orphan',
      after: afterPhase('lengthEquals', 0),
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('passed');
    expect(detections).toHaveLength(0);
  });
});

describe('data_integrity_orphan — violated', () => {
  it('detects violation when orphan query returns non-empty array', async () => {
    mockQueryJson([{ id: 1, userId: 42 }]);
    const inv = makeInvariant({
      bugKind: 'data_integrity_orphan',
      after: afterPhase('lengthEquals', 0),
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('violated');
    expect(detections).toHaveLength(1);
    expect(detections[0].kind).toBe('data_integrity_orphan');
  });
});

// ---------------------------------------------------------------------------
// soft_delete_consistency
// ---------------------------------------------------------------------------

describe('soft_delete_consistency — happy path', () => {
  it('passes when deletedAt matches expected value', async () => {
    mockQueryJson({ id: 42, deletedAt: '2024-01-01' });
    const inv = makeInvariant({
      bugKind: 'soft_delete_consistency',
      after: afterPhase('equals', '2024-01-01', 'deletedAt'),
    });
    const { evaluations } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('passed');
  });
});

describe('soft_delete_consistency — violated', () => {
  it('detects when record was hard-deleted (deletedAt is null)', async () => {
    mockQueryJson({ id: 42, deletedAt: null });
    const inv = makeInvariant({
      bugKind: 'soft_delete_consistency',
      after: afterPhase('notEquals', null, 'deletedAt'),
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('violated');
    expect(detections[0].kind).toBe('soft_delete_consistency');
  });
});

// ---------------------------------------------------------------------------
// cache_staleness
// ---------------------------------------------------------------------------

describe('cache_staleness — happy path', () => {
  it('passes when cache returns fresh data after mutation', async () => {
    mockQueryJson({ value: 'fresh' });
    const inv = makeInvariant({
      bugKind: 'cache_staleness',
      after: afterPhase('equals', 'fresh', 'value'),
    });
    const { evaluations } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('passed');
  });
});

describe('cache_staleness — violated', () => {
  it('detects stale cache when value unchanged after mutation', async () => {
    mockQueryJson({ value: 'stale' });
    const inv = makeInvariant({
      bugKind: 'cache_staleness',
      after: afterPhase('equals', 'fresh', 'value'),
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('violated');
    expect(detections[0].kind).toBe('cache_staleness');
  });
});

// ---------------------------------------------------------------------------
// audit_log_missing_for_mutation
// ---------------------------------------------------------------------------

describe('audit_log_missing_for_mutation — happy path', () => {
  it('passes when audit log contains at least one entry', async () => {
    mockQueryJson([{ actionId: 'delete-user', userId: 42 }]);
    const inv = makeInvariant({
      bugKind: 'audit_log_missing_for_mutation',
      after: afterPhase('lengthGte', 1),
    });
    const { evaluations } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('passed');
  });
});

describe('audit_log_missing_for_mutation — violated', () => {
  it('detects missing audit log entry', async () => {
    mockQueryJson([]);
    const inv = makeInvariant({
      bugKind: 'audit_log_missing_for_mutation',
      after: afterPhase('lengthGte', 1),
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('violated');
    expect(detections[0].kind).toBe('audit_log_missing_for_mutation');
  });
});

// ---------------------------------------------------------------------------
// money_math_precision
// ---------------------------------------------------------------------------

describe('money_math_precision — happy path', () => {
  it('passes when numeric value matches within tolerance', async () => {
    mockQueryText('0.30');
    const inv = makeInvariant({
      bugKind: 'money_math_precision',
      injectInputs: [{ field: 'amount', values: ['0.10', '0.20'] }],
      after: {
        query: checkQuery,
        parse: 'text',
        expect: { op: 'numericEquals', value: 0.30, tolerance: 0.0001 },
      },
    });
    const { evaluations } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('passed');
  });
});

describe('money_math_precision — violated', () => {
  it('detects value outside tolerance', async () => {
    // Simulate a stored value that is wrong — e.g. off by 0.01 (a real precision bug)
    mockQueryText('0.29');
    const inv = makeInvariant({
      bugKind: 'money_math_precision',
      injectInputs: [{ field: 'amount', values: ['0.10', '0.20'] }],
      after: {
        query: checkQuery,
        parse: 'text',
        expect: { op: 'numericEquals', value: 0.30, tolerance: 0.001 },
      },
    });
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('violated');
    expect(detections[0].kind).toBe('money_math_precision');
  });
});

// ---------------------------------------------------------------------------
// idempotency_key_violation — skipped (no replay clause)
// ---------------------------------------------------------------------------

describe('idempotency_key_violation — skipped', () => {
  it('records skipped outcome when no replay and no after clause', async () => {
    const inv: DataIntegrityInvariant = {
      name: 'idempotency-test',
      bugKind: 'idempotency_key_violation',
      appliesTo: {},
      // no after, no replay
    };
    const { evaluations, detections } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('skipped');
    expect(detections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Query failure
// ---------------------------------------------------------------------------

describe('query failure handling', () => {
  it('records queryFailed outcome when hook returns ok:false', async () => {
    mockQueryFail();
    const inv = makeInvariant({});
    const { evaluations } = await evaluateInvariantsAfter([{ inv, tc, beforeStore: {} }], tc, actionResult, ctx);
    expect(evaluations[0].outcome).toBe('query_failed');
    expect(evaluations[0].ok).toBe(false);
  });
});
