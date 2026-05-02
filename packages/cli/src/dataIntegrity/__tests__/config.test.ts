// Unit tests for the v0.42 dataIntegrity Zod schema (§7 acceptance).
// Tests that valid configs parse and invalid configs reject with the right messages.

import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../config.js';

// Minimal valid config satisfying ConfigSchema required fields
const baseConfig = {
  projectName: 'test-project',
  surfaceMcpUrl: 'http://localhost:8080',
};

const validAfterQuery = {
  kind: 'http',
  url: 'http://localhost:3000/api/check',
  method: 'GET',
  format: 'json',
};

function parseDataIntegrity(invariants: unknown[]) {
  return ConfigSchema.safeParse({
    ...baseConfig,
    dataIntegrity: { invariants },
  });
}

describe('dataIntegrity schema — happy path', () => {
  it('parses data_integrity_orphan invariant', () => {
    const result = parseDataIntegrity([{
      name: 'orphan-check',
      bugKind: 'data_integrity_orphan',
      appliesTo: { actionIds: ['delete-user'] },
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses soft_delete_consistency invariant', () => {
    const result = parseDataIntegrity([{
      name: 'soft-delete',
      bugKind: 'soft_delete_consistency',
      appliesTo: {},
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses cache_staleness invariant', () => {
    const result = parseDataIntegrity([{
      name: 'cache-check',
      bugKind: 'cache_staleness',
      appliesTo: { method: 'POST' },
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses audit_log_missing_for_mutation invariant', () => {
    const result = parseDataIntegrity([{
      name: 'audit-log',
      bugKind: 'audit_log_missing_for_mutation',
      appliesTo: { method: ['POST', 'PUT', 'DELETE'] },
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses idempotency_key_violation with required replay clause', () => {
    const result = parseDataIntegrity([{
      name: 'idempotency-check',
      bugKind: 'idempotency_key_violation',
      appliesTo: {},
      replay: { withSameIdempotencyKey: true, expectSameResponseShape: true },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses money_math_precision with required injectInputs', () => {
    const result = parseDataIntegrity([{
      name: 'money-precision',
      bugKind: 'money_math_precision',
      appliesTo: {},
      injectInputs: [{ field: 'amount', values: ['0.10', '0.20'] }],
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(true);
  });

  it('parses enabled flag', () => {
    const result = ConfigSchema.safeParse({
      ...baseConfig,
      dataIntegrity: {
        enabled: false,
        invariants: [],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.dataIntegrity?.enabled).toBe(false);
  });

  it('dataIntegrity is optional — omitting it parses successfully', () => {
    const result = ConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    expect(result.data?.dataIntegrity).toBeUndefined();
  });
});

describe('dataIntegrity schema — superRefine cross-checks', () => {
  it('rejects idempotency_key_violation without replay', () => {
    const result = parseDataIntegrity([{
      name: 'bad-idempotency',
      bugKind: 'idempotency_key_violation',
      appliesTo: {},
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('replay');
    }
  });

  it('rejects money_math_precision without injectInputs', () => {
    const result = parseDataIntegrity([{
      name: 'bad-money',
      bugKind: 'money_math_precision',
      appliesTo: {},
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('injectInputs');
    }
  });

  it('rejects data_integrity_orphan without after clause', () => {
    const result = parseDataIntegrity([{
      name: 'bad-orphan',
      bugKind: 'data_integrity_orphan',
      appliesTo: {},
    }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('after');
    }
  });

  it('rejects unknown bugKind', () => {
    const result = parseDataIntegrity([{
      name: 'bad-kind',
      bugKind: 'not_a_real_kind',
      appliesTo: {},
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(false);
  });

  it('rejects invariant with missing name', () => {
    const result = parseDataIntegrity([{
      bugKind: 'data_integrity_orphan',
      appliesTo: {},
      after: { query: validAfterQuery },
    }]);
    expect(result.success).toBe(false);
  });
});

describe('dataIntegrity schema — appliesTo variants', () => {
  const baseInvariant = {
    name: 'inv',
    bugKind: 'data_integrity_orphan',
    appliesTo: {},
    after: { query: validAfterQuery },
  };

  it('accepts string method', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { method: 'POST' } }]);
    expect(r.success).toBe(true);
  });

  it('accepts array method', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { method: ['POST', 'DELETE'] } }]);
    expect(r.success).toBe(true);
  });

  it('accepts urlPattern', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { urlPattern: '/api/.*' } }]);
    expect(r.success).toBe(true);
  });

  it('accepts palette enum', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { palette: 'happy' } }]);
    expect(r.success).toBe(true);
  });

  it('accepts palette array', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { palette: ['happy', 'edge'] } }]);
    expect(r.success).toBe(true);
  });

  it('accepts actionIds array', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, appliesTo: { actionIds: ['a', 'b'] } }]);
    expect(r.success).toBe(true);
  });

  it('accepts extract clause', () => {
    const r = parseDataIntegrity([{
      ...baseInvariant,
      extract: {
        userId: { from: 'actionRequestBody', jsonPath: 'id' },
      },
    }]);
    expect(r.success).toBe(true);
  });

  it('accepts continueOnError flag', () => {
    const r = parseDataIntegrity([{ ...baseInvariant, continueOnError: true }]);
    expect(r.success).toBe(true);
  });
});
