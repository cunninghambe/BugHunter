import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FAULT_PALETTE,
  ALL_FAULT_VARIANTS,
  resolveFaultPalette,
  isToolDenylisted,
} from './network-fault-palette.js';

describe('DEFAULT_FAULT_PALETTE', () => {
  it('has six variants by default', () => {
    expect(DEFAULT_FAULT_PALETTE).toHaveLength(6);
  });

  it('excludes slow_3g and timeout_at_request', () => {
    const kinds = DEFAULT_FAULT_PALETTE.map(f => f.kind);
    expect(kinds).not.toContain('slow_3g');
    expect(kinds).not.toContain('timeout_at_request');
  });

  it('includes the six expected variants', () => {
    const kinds = DEFAULT_FAULT_PALETTE.map(f => f.kind);
    expect(kinds).toContain('offline');
    expect(kinds).toContain('high_latency');
    expect(kinds).toContain('timeout_at_response');
    expect(kinds).toContain('server_5xx');
    expect(kinds).toContain('intermittent');
    expect(kinds).toContain('malformed_response');
  });
});

describe('ALL_FAULT_VARIANTS', () => {
  it('has eight variants', () => {
    expect(ALL_FAULT_VARIANTS).toHaveLength(8);
  });

  it('includes slow_3g and timeout_at_request', () => {
    const kinds = ALL_FAULT_VARIANTS.map(f => f.kind);
    expect(kinds).toContain('slow_3g');
    expect(kinds).toContain('timeout_at_request');
  });
});

describe('resolveFaultPalette', () => {
  it('returns DEFAULT_FAULT_PALETTE when no config provided', () => {
    expect(resolveFaultPalette()).toBe(DEFAULT_FAULT_PALETTE);
  });

  it('returns DEFAULT_FAULT_PALETTE when empty array provided', () => {
    expect(resolveFaultPalette([])).toBe(DEFAULT_FAULT_PALETTE);
  });

  it('returns user-configured variants when provided', () => {
    const custom = [{ kind: 'offline' as const }, { kind: 'slow_3g' as const }];
    expect(resolveFaultPalette(custom)).toBe(custom);
  });
});

describe('isToolDenylisted', () => {
  it('returns false when denylist is empty', () => {
    expect(isToolDenylisted('payments.charge', [])).toBe(false);
  });

  it('exact match returns true', () => {
    expect(isToolDenylisted('payments.charge', ['payments.charge'])).toBe(true);
  });

  it('non-matching exact string returns false', () => {
    expect(isToolDenylisted('payments.charge', ['payments.refund'])).toBe(false);
  });

  it('glob pattern with trailing * matches prefix', () => {
    expect(isToolDenylisted('payments.charge', ['payments.*'])).toBe(true);
    expect(isToolDenylisted('payments.refund', ['payments.*'])).toBe(true);
    expect(isToolDenylisted('orders.create', ['payments.*'])).toBe(false);
  });

  it('glob pattern without trailing * is exact match', () => {
    expect(isToolDenylisted('payments', ['payments'])).toBe(true);
  });
});
