// Unit tests for dataIntegrity/filter.ts

import { describe, it, expect } from 'vitest';
import { filterInvariants } from '../filter.js';
import type { DataIntegrityInvariant, TestCase } from '../../types.js';

function makeInvariant(overrides: Partial<DataIntegrityInvariant> = {}): DataIntegrityInvariant {
  return {
    name: 'test-invariant',
    bugKind: 'data_integrity_orphan',
    appliesTo: {},
    after: { query: { kind: 'http', url: 'http://example.com/check', method: 'GET' }, parse: 'json', expect: { op: 'lengthEquals', value: 0 } },
    ...overrides,
  };
}

function makeTc(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'action-create',
    runId: 'run-1',
    role: 'admin',
    page: '/api/users',
    palette: 'happy',
    action: { kind: 'submit', via: 'api', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    ...overrides,
  };
}

describe('filterInvariants — no filter (matches all)', () => {
  it('returns invariant when appliesTo is empty', () => {
    const inv = makeInvariant({ appliesTo: {} });
    expect(filterInvariants([inv], makeTc())).toEqual([inv]);
  });
});

describe('filterInvariants — actionIds filter', () => {
  it('matches when actionId is in list', () => {
    const inv = makeInvariant({ appliesTo: { actionIds: ['action-create', 'action-update'] } });
    expect(filterInvariants([inv], makeTc({ id: 'action-create' }))).toHaveLength(1);
  });

  it('excludes when actionId not in list', () => {
    const inv = makeInvariant({ appliesTo: { actionIds: ['action-delete'] } });
    expect(filterInvariants([inv], makeTc({ id: 'action-create' }))).toHaveLength(0);
  });

  it('actionIds short-circuits other filters', () => {
    // actionIds match overrides the method filter
    const inv = makeInvariant({
      appliesTo: { actionIds: ['action-create'], method: 'DELETE' },
    });
    expect(filterInvariants([inv], makeTc({ id: 'action-create' }))).toHaveLength(1);
  });
});

describe('filterInvariants — method filter', () => {
  it('matches api action (treated as POST)', () => {
    const inv = makeInvariant({ appliesTo: { method: 'POST' } });
    const tc = makeTc({ action: { kind: 'submit', via: 'api', expectedOutcome: 'success', palette: 'happy' } });
    expect(filterInvariants([inv], tc)).toHaveLength(1);
  });

  it('accepts array of methods', () => {
    const inv = makeInvariant({ appliesTo: { method: ['POST', 'PUT'] } });
    const tc = makeTc({ action: { kind: 'submit', via: 'api', expectedOutcome: 'success', palette: 'happy' } });
    expect(filterInvariants([inv], tc)).toHaveLength(1);
  });

  it('excludes ui actions from method filter (ui has no HTTP method)', () => {
    const inv = makeInvariant({ appliesTo: { method: 'POST' } });
    const tc = makeTc({ action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy' } });
    expect(filterInvariants([inv], tc)).toHaveLength(0);
  });

  it('excludes when method does not match', () => {
    const inv = makeInvariant({ appliesTo: { method: 'DELETE' } });
    const tc = makeTc({ action: { kind: 'submit', via: 'api', expectedOutcome: 'success', palette: 'happy' } });
    expect(filterInvariants([inv], tc)).toHaveLength(0);
  });
});

describe('filterInvariants — urlPattern filter', () => {
  it('matches page url against pattern', () => {
    const inv = makeInvariant({ appliesTo: { urlPattern: '/api/users.*' } });
    expect(filterInvariants([inv], makeTc({ page: '/api/users/42' }))).toHaveLength(1);
  });

  it('excludes when url does not match pattern', () => {
    const inv = makeInvariant({ appliesTo: { urlPattern: '/api/orders.*' } });
    expect(filterInvariants([inv], makeTc({ page: '/api/users/42' }))).toHaveLength(0);
  });

  it('excludes when page is empty (no url)', () => {
    const inv = makeInvariant({ appliesTo: { urlPattern: '/api/.*' } });
    expect(filterInvariants([inv], makeTc({ page: '' }))).toHaveLength(0);
  });
});

describe('filterInvariants — palette filter', () => {
  it('matches when palette matches', () => {
    const inv = makeInvariant({ appliesTo: { palette: 'happy' } });
    expect(filterInvariants([inv], makeTc({ palette: 'happy' }))).toHaveLength(1);
  });

  it('accepts array of palettes', () => {
    const inv = makeInvariant({ appliesTo: { palette: ['happy', 'edge'] } });
    expect(filterInvariants([inv], makeTc({ palette: 'edge' }))).toHaveLength(1);
  });

  it('excludes when palette does not match', () => {
    const inv = makeInvariant({ appliesTo: { palette: 'edge' } });
    expect(filterInvariants([inv], makeTc({ palette: 'happy' }))).toHaveLength(0);
  });
});

describe('filterInvariants — multiple invariants', () => {
  it('returns only matching invariants from a list', () => {
    const invA = makeInvariant({ name: 'inv-a', appliesTo: { actionIds: ['action-create'] } });
    const invB = makeInvariant({ name: 'inv-b', appliesTo: { actionIds: ['action-delete'] } });
    const invC = makeInvariant({ name: 'inv-c', appliesTo: {} });
    const result = filterInvariants([invA, invB, invC], makeTc({ id: 'action-create' }));
    expect(result.map(r => r.name)).toEqual(['inv-a', 'inv-c']);
  });
});
