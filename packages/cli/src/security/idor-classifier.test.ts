// Unit tests for the IDOR outcome classifier (v0.21 §10.3).

import { describe, it, expect } from 'vitest';
import { classifyIdorOutcome, resolveTier, type IdorClassifyInput } from './idor-classifier.js';

const BODY = { id: 'order-1', amount: 100 };

function makeInput(overrides: Partial<IdorClassifyInput> = {}): IdorClassifyInput {
  return {
    sourceRole: 'alice',
    targetRole: 'bob',
    sideEffectClass: 'safe',
    status: 200,
    body: BODY,
    resourceType: 'order',
    idorConfig: undefined,
    ...overrides,
  };
}

describe('classifyIdorOutcome — peer-tier pairs', () => {
  it('returns idor_horizontal_read for safe tool, peer tiers, 200 non-empty', () => {
    const out = classifyIdorOutcome(makeInput());
    expect(out?.kind).toBe('idor_horizontal_read');
    expect(out?.tier).toBe('peer');
    expect(out?.requiresAdjudication).toBe(false);
  });

  it('returns idor_horizontal_mutate for mutating tool, peer tiers, 200 non-empty', () => {
    const out = classifyIdorOutcome(makeInput({ sideEffectClass: 'mutating' }));
    expect(out?.kind).toBe('idor_horizontal_mutate');
    expect(out?.tier).toBe('peer');
  });

  it('returns null for 4xx (correct gate)', () => {
    expect(classifyIdorOutcome(makeInput({ status: 403 }))).toBeNull();
    expect(classifyIdorOutcome(makeInput({ status: 404 }))).toBeNull();
  });

  it('returns null for 3xx redirect (correctly gated)', () => {
    expect(classifyIdorOutcome(makeInput({ status: 302 }))).toBeNull();
  });

  it('returns null for 5xx (server error, not an authz signal)', () => {
    expect(classifyIdorOutcome(makeInput({ status: 500 }))).toBeNull();
  });

  it('returns null for 429 rate-limit (EC-4)', () => {
    expect(classifyIdorOutcome(makeInput({ status: 429 }))).toBeNull();
  });

  it('returns null when body is null', () => {
    expect(classifyIdorOutcome(makeInput({ body: null }))).toBeNull();
  });

  it('returns null when body is empty array', () => {
    expect(classifyIdorOutcome(makeInput({ body: [] }))).toBeNull();
  });

  it('returns null when body is {data: null}', () => {
    expect(classifyIdorOutcome(makeInput({ body: { data: null } }))).toBeNull();
  });

  it('returns null when body is {data: []}', () => {
    expect(classifyIdorOutcome(makeInput({ body: { data: [] } }))).toBeNull();
  });

  it('returns null for external sideEffectClass', () => {
    expect(classifyIdorOutcome(makeInput({ sideEffectClass: 'external' }))).toBeNull();
  });
});

describe('classifyIdorOutcome — cross-tier pairs', () => {
  it('returns idor_vertical_suspicious when source is admin-hinted and target is not', () => {
    const out = classifyIdorOutcome(makeInput({ sourceRole: 'admin', targetRole: 'alice' }));
    expect(out?.kind).toBe('idor_vertical_suspicious');
    expect(out?.tier).toBe('cross');
    expect(out?.requiresAdjudication).toBe(true);
  });

  it('returns idor_vertical_suspicious for low→high tier too', () => {
    const out = classifyIdorOutcome(makeInput({ sourceRole: 'alice', targetRole: 'admin' }));
    expect(out?.kind).toBe('idor_vertical_suspicious');
  });

  it('suppresses cross-tier when legitimizedHierarchies matches accessor→owner (admin reads alice)', () => {
    // alice is the data owner (sourceRole), admin is the accessor (targetRole)
    // { from: 'admin', to: 'alice' } means "admin accessing alice's data is legitimate"
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'alice',
      targetRole: 'admin',
      idorConfig: { legitimizedHierarchies: [{ from: 'admin', to: 'alice' }] },
    }));
    expect(out).toBeNull();
  });

  it('does NOT suppress when legitimizedHierarchies matches only the reverse direction', () => {
    // alice is owner, admin is accessor — but hierarchy only lists {from: alice, to: admin}
    // which would mean "alice accessing admin's data" — not the direction being tested here
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'alice',
      targetRole: 'admin',
      idorConfig: { legitimizedHierarchies: [{ from: 'alice', to: 'admin' }] },
    }));
    expect(out?.kind).toBe('idor_vertical_suspicious');
  });

  it('uses explicit idor.tiers to determine peer vs cross', () => {
    // Both customer and support are tier 0 and tier 1 respectively — cross-tier
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'customer',
      targetRole: 'support',
      idorConfig: { tiers: { customer: 0, support: 1 } },
    }));
    expect(out?.kind).toBe('idor_vertical_suspicious');
  });

  it('uses explicit idor.tiers — same tier means peer', () => {
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'seller',
      targetRole: 'buyer',
      idorConfig: { tiers: { seller: 0, buyer: 0 } },
    }));
    expect(out?.kind).toBe('idor_horizontal_read');
  });
});

describe('classifyIdorOutcome — peerRoles override', () => {
  it('peerRoles override: listed pair is peer even if tiers differ', () => {
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'seller',
      targetRole: 'buyer',
      idorConfig: {
        tiers: { seller: 0, buyer: 1 },
        peerRoles: [['seller', 'buyer']],
      },
    }));
    expect(out?.kind).toBe('idor_horizontal_read');
  });

  it('peerRoles override: unlisted pair is NOT peer (cross-tier)', () => {
    const out = classifyIdorOutcome(makeInput({
      sourceRole: 'alice',
      targetRole: 'bob',
      idorConfig: {
        peerRoles: [['seller', 'buyer']],
      },
    }));
    // alice and bob are both tier 0 by default, but peerRoles is set and they're not listed
    // per spec §7.4: when peerRoles is set, only listed pairs are peer
    expect(out?.kind).toBe('idor_vertical_suspicious');
  });
});

describe('resolveTier', () => {
  it('uses explicit tiers config', () => {
    expect(resolveTier('admin', { tiers: { admin: 2, customer: 0 } })).toBe(2);
    expect(resolveTier('customer', { tiers: { admin: 2, customer: 0 } })).toBe(0);
  });

  it('falls back to admin hint: admin → tier 1', () => {
    expect(resolveTier('admin', undefined)).toBe(1);
    expect(resolveTier('superuser', undefined)).toBe(1);
    expect(resolveTier('owner', undefined)).toBe(1);
  });

  it('falls back to admin hint: regular role → tier 0', () => {
    expect(resolveTier('customer', undefined)).toBe(0);
    expect(resolveTier('alice', undefined)).toBe(0);
  });
});
