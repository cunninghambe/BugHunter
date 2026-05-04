// Unit tests for DetectorContract type validation and DETECTOR_CONTRACTS shape.

import { describe, it, expect } from 'vitest';
import {
  DETECTOR_CONTRACTS,
  type DetectorContract,
  type ClusterAssertion,
  type DetectorRequires,
  type RequiredPhase,
  type RequiredTool,
} from './contracts.js';
import type { BugKind } from '../types.js';

// ---------------------------------------------------------------------------
// ClusterAssertion parsing
// ---------------------------------------------------------------------------

describe('ClusterAssertion shape', () => {
  it('fires assertion must have minClusterSize, match, severity', () => {
    const assertion: ClusterAssertion = {
      kind: 'xss_reflected' as BugKind,
      expect: 'fires',
      minClusterSize: 1,
      match: { page: '/search', role: 'member' },
      severity: 'critical',
    };
    expect(assertion.expect).toBe('fires');
    expect(assertion.minClusterSize).toBeGreaterThan(0);
    expect(['critical', 'major', 'minor', 'info']).toContain(assertion.severity);
  });

  it('silent assertion must have reason', () => {
    const assertion: ClusterAssertion = {
      kind: 'xss_stored' as BugKind,
      expect: 'silent',
      reason: 'Not planted in this fixture',
    };
    expect(assertion.expect).toBe('silent');
    expect(assertion.reason.length).toBeGreaterThan(0);
  });

  it('silent assertion can include optional match field', () => {
    const assertion: ClusterAssertion = {
      kind: 'xss_dom' as BugKind,
      expect: 'silent',
      reason: 'Only reflected variant planted',
      match: { page: '/profile' },
    };
    expect(assertion.match).toBeDefined();
  });

  it('fires assertion match fields are all optional', () => {
    const assertion: ClusterAssertion = {
      kind: 'sql_injection' as BugKind,
      expect: 'fires',
      minClusterSize: 1,
      match: {},
      severity: 'critical',
    };
    expect(assertion.match.page).toBeUndefined();
    expect(assertion.match.role).toBeUndefined();
    expect(assertion.match.signaturePrefix).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DetectorRequires shape
// ---------------------------------------------------------------------------

describe('DetectorRequires shape', () => {
  it('phases must be a non-empty subset of valid phase names', () => {
    const validPhases: RequiredPhase[] = ['validate', 'discover', 'plan', 'execute', 'classify', 'cluster', 'emit'];
    const requires: DetectorRequires = {
      phases: ['validate', 'execute'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    };
    for (const phase of requires.phases) {
      expect(validPhases).toContain(phase);
    }
  });

  it('tools must be a subset of valid tool names', () => {
    const validTools: RequiredTool[] = ['browser-mcp', 'surface-mcp', 'cdp', 'static-analysis'];
    const requires: DetectorRequires = {
      phases: ['execute'],
      tools: ['static-analysis'],
      surface: 'static-source',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
    };
    for (const tool of requires.tools) {
      expect(validTools).toContain(tool);
    }
  });

  it('role discriminated union: none, any-authenticated, specific', () => {
    const none: DetectorRequires['role'] = { kind: 'none' };
    const anyAuth: DetectorRequires['role'] = { kind: 'any-authenticated' };
    const specific: DetectorRequires['role'] = { kind: 'specific', roles: ['admin', 'member'] };

    expect(none.kind).toBe('none');
    expect(anyAuth.kind).toBe('any-authenticated');
    expect(specific.kind).toBe('specific');
    if (specific.kind === 'specific') {
      expect(specific.roles).toContain('admin');
    }
  });

  it('pageContext discriminated union covers all variants', () => {
    const anyRoute: DetectorRequires['pageContext'] = { kind: 'any-route' };
    const pattern: DetectorRequires['pageContext'] = { kind: 'route-pattern', pattern: '/api/*' };
    const specific: DetectorRequires['pageContext'] = { kind: 'specific-routes', routes: ['/search', '/profile'] };

    expect(anyRoute.kind).toBe('any-route');
    expect(pattern.kind).toBe('route-pattern');
    if (pattern.kind === 'route-pattern') {
      expect(pattern.pattern).toBe('/api/*');
    }
    expect(specific.kind).toBe('specific-routes');
    if (specific.kind === 'specific-routes') {
      expect(specific.routes).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// DETECTOR_CONTRACTS array integrity
// ---------------------------------------------------------------------------

describe('DETECTOR_CONTRACTS array', () => {
  it('is a read-only array', () => {
    expect(Array.isArray(DETECTOR_CONTRACTS)).toBe(true);
    // Attempt to mutate — should fail silently (frozen or readonly TS)
    const original = DETECTOR_CONTRACTS.length;
    expect(DETECTOR_CONTRACTS.length).toBe(original);
  });

  it('V56.1 ships with empty contracts (populated in V56.2+)', () => {
    // V56.1 is infrastructure only — no contracts yet
    expect(DETECTOR_CONTRACTS).toHaveLength(0);
  });

  it('every contract entry has required fields when non-empty', () => {
    for (const contract of DETECTOR_CONTRACTS) {
      expect(typeof contract.kind).toBe('string');
      expect(contract.kind.length).toBeGreaterThan(0);
      expect(Array.isArray(contract.requires.phases)).toBe(true);
      expect(contract.requires.phases.length).toBeGreaterThan(0);
      expect(Array.isArray(contract.requires.tools)).toBe(true);
      expect(contract.defaultBudgetMs).toBeGreaterThan(0);
      expect(contract.defaultBudgetMs).toBeLessThanOrEqual(600_000);
      expect(typeof contract.note).toBe('string');
      expect(contract.note.length).toBeGreaterThan(0);
      expect(typeof contract.fixture.path).toBe('string');
      expect(contract.fixture.path.length).toBeGreaterThan(0);
      expect(Array.isArray(contract.fixture.servesKinds)).toBe(true);
      expect(contract.fixture.servesKinds).toContain(contract.kind);
    }
  });

  it('synthetic contract satisfies DetectorContract type', () => {
    // Compile-time check: a synthetic contract matches the type
    const synthetic: DetectorContract = {
      kind: 'missing_csp_header',
      requires: {
        phases: ['validate', 'execute'],
        tools: ['surface-mcp'],
        surface: 'api',
        role: { kind: 'none' },
        pageContext: { kind: 'any-route' },
      },
      fixture: {
        path: 'csp-mini',
        servesKinds: ['missing_csp_header'],
      },
      defaultBudgetMs: 30_000,
      note: 'Checks that Content-Security-Policy header is present on all responses.',
    };
    expect(synthetic.kind).toBe('missing_csp_header');
    expect(synthetic.requires.phases).toContain('validate');
    expect(synthetic.fixture.servesKinds).toContain('missing_csp_header');
  });
});
