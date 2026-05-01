// AC-1: Zod schemas parse spec fixtures cleanly.
import { describe, it, expect } from 'vitest';
import {
  SuppressionPatternSchema,
  SuppressionEntrySchema,
  SuppressionsSchema,
  AuditEventSchema,
} from './types.js';

const VALID_ENTRY = {
  id: 'abc123',
  pattern: 'kind:console_error',
  reason: 'Known flaky test env noise',
  addedBy: 'dev@example.com',
  addedAt: '2026-04-30T12:00:00.000Z',
};

describe('SuppressionPatternSchema', () => {
  it('accepts all five prefix types', () => {
    expect(() => SuppressionPatternSchema.parse('bugIdentity:abc|def')).not.toThrow();
    expect(() => SuppressionPatternSchema.parse('kind:console_error')).not.toThrow();
    expect(() => SuppressionPatternSchema.parse('endpoint:/api/users/*')).not.toThrow();
    expect(() => SuppressionPatternSchema.parse('suspectedFile:src/**/*.ts')).not.toThrow();
    expect(() => SuppressionPatternSchema.parse('severity:critical')).not.toThrow();
  });

  it('rejects unknown prefix', () => {
    expect(() => SuppressionPatternSchema.parse('url:/api/foo')).toThrow();
    expect(() => SuppressionPatternSchema.parse('type:console_error')).toThrow();
  });

  it('rejects bare value without prefix', () => {
    expect(() => SuppressionPatternSchema.parse('console_error')).toThrow();
  });

  it('rejects pattern with whitespace in value', () => {
    expect(() => SuppressionPatternSchema.parse('kind:foo bar')).toThrow();
  });

  it('rejects empty value after colon', () => {
    expect(() => SuppressionPatternSchema.parse('kind:')).toThrow();
  });
});

describe('SuppressionEntrySchema', () => {
  it('parses minimal valid entry', () => {
    const result = SuppressionEntrySchema.safeParse(VALID_ENTRY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matchCount).toBeUndefined();
      expect(result.data.expiresAt).toBeUndefined();
    }
  });

  it('parses entry with optional fields', () => {
    const entry = {
      ...VALID_ENTRY,
      expiresAt: '2026-12-31T00:00:00.000Z',
      lastMatchedAt: '2026-04-30T12:01:00.000Z',
      matchCount: 5,
      sourceClusterId: 'cid_abc',
    };
    const result = SuppressionEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects reason with newline', () => {
    const result = SuppressionEntrySchema.safeParse({ ...VALID_ENTRY, reason: 'foo\nbar' });
    expect(result.success).toBe(false);
  });

  it('rejects reason longer than 1000 chars', () => {
    const result = SuppressionEntrySchema.safeParse({ ...VALID_ENTRY, reason: 'x'.repeat(1001) });
    expect(result.success).toBe(false);
  });

  it('rejects missing addedAt', () => {
    const { addedAt: _, ...withoutDate } = VALID_ENTRY;
    const result = SuppressionEntrySchema.safeParse(withoutDate);
    expect(result.success).toBe(false);
  });

  it('rejects negative matchCount', () => {
    const result = SuppressionEntrySchema.safeParse({ ...VALID_ENTRY, matchCount: -1 });
    expect(result.success).toBe(false);
  });
});

describe('SuppressionsSchema', () => {
  it('parses empty array', () => {
    expect(SuppressionsSchema.parse([])).toEqual([]);
  });

  it('parses array of valid entries', () => {
    const data = [VALID_ENTRY, { ...VALID_ENTRY, id: 'xyz', pattern: 'endpoint:/api/*' }];
    const result = SuppressionsSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});

describe('AuditEventSchema', () => {
  it('parses suppress event', () => {
    const event = {
      kind: 'suppress',
      timestamp: '2026-04-30T12:00:00.000Z',
      actor: 'dev@example.com',
      pattern: 'kind:console_error',
      reason: 'Known noise',
      suppressionId: 'sup_abc123',
    };
    const result = AuditEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('parses unsuppress event', () => {
    const event = {
      kind: 'unsuppress',
      timestamp: '2026-04-30T12:05:00.000Z',
      actor: 'dev@example.com',
      pattern: 'kind:console_error',
      removedSuppressionIds: ['sup_abc123'],
      removedCount: 1,
    };
    const result = AuditEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('rejects suppress event without suppressionId', () => {
    const event = {
      kind: 'suppress',
      timestamp: '2026-04-30T12:00:00.000Z',
      actor: 'dev@example.com',
      pattern: 'kind:console_error',
      reason: 'Known noise',
    };
    const result = AuditEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('rejects unsuppress with empty removedSuppressionIds', () => {
    const event = {
      kind: 'unsuppress',
      timestamp: '2026-04-30T12:05:00.000Z',
      actor: 'dev@example.com',
      pattern: 'kind:console_error',
      removedSuppressionIds: [],
      removedCount: 0,
    };
    const result = AuditEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = AuditEventSchema.safeParse({ kind: 'delete', timestamp: '2026-04-30T12:00:00.000Z' });
    expect(result.success).toBe(false);
  });
});
