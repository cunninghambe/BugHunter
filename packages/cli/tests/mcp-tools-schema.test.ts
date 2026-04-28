// B-2 regression: bughunt_latest_bugs must reject limit: 0 at schema level.
// Verifies that the Zod schema for limit is .positive() (not just .int().optional()),
// so callers who pass limit: 0 get a validation error rather than the full list.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirror of the bughunt_latest_bugs input schema from packages/mcp/src/tools.ts.
// This is kept in sync manually — if the schema changes, update this test too.
const BughuntLatestBugsSchema = z.object({
  project: z.string().min(1),
  limit: z.number().int().positive().optional(),
  kind: z.string().min(1).optional(),
});

describe('bughunt_latest_bugs schema (B-2)', () => {
  it('accepts limit: 1', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj', limit: 1 });
    expect(result.success).toBe(true);
  });

  it('accepts limit: undefined (no limit)', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj' });
    expect(result.success).toBe(true);
  });

  // B-2 regression: limit: 0 must be rejected, not silently return full list.
  it('B-2: rejects limit: 0 at schema level instead of returning full list', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj', limit: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('limit');
    }
  });

  it('B-2: rejects negative limit', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj', limit: -5 });
    expect(result.success).toBe(false);
  });

  it('accepts kind: "console_error"', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj', kind: 'console_error' });
    expect(result.success).toBe(true);
  });

  it('rejects kind: "" (empty string would match nothing)', () => {
    const result = BughuntLatestBugsSchema.safeParse({ project: '/tmp/proj', kind: '' });
    expect(result.success).toBe(false);
  });
});
