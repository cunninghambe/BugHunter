// Tests for cluster signature derivation — v0.5 new BugKinds.

import { describe, it, expect } from 'vitest';
import { clusterSignature } from './signature.js';
import type { BugDetection } from '../types.js';

function make(kind: BugDetection['kind'], overrides: Partial<BugDetection> = {}): BugDetection {
  return { kind, rootCause: 'test', ...overrides };
}

describe('clusterSignature — v0.5 security kinds', () => {
  it('missing_csp_header collapses by origin', () => {
    const a = make('missing_csp_header', {
      endpoint: 'http://app.test',
      headerContext: { headerName: 'Content-Security-Policy', expectedShape: 'present', observedValue: 'http://app.test' },
    });
    const b = make('missing_csp_header', {
      endpoint: 'http://app.test',
      headerContext: { headerName: 'Content-Security-Policy', expectedShape: 'present', observedValue: 'http://app.test' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
  });

  it('permissive_cors collapses by route+rule', () => {
    const a = make('permissive_cors', {
      endpoint: '/api/data',
      headerContext: { headerName: 'Access-Control-Allow-Origin', expectedShape: 'permissive_credentialed' },
    });
    const b = make('permissive_cors', {
      endpoint: '/api/other',
      headerContext: { headerName: 'Access-Control-Allow-Origin', expectedShape: 'permissive_credentialed' },
    });
    // Different routes → different signatures
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('cookie_security_flags collapses by cookie name + flag', () => {
    const a = make('cookie_security_flags', {
      headerContext: { headerName: 'tj_sess', expectedShape: 'no_http_only' },
    });
    const b = make('cookie_security_flags', {
      headerContext: { headerName: 'tj_sess', expectedShape: 'no_secure' },
    });
    // Different flag → different signatures
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('idor_horizontal collapses by toolId + field', () => {
    const a = make('idor_horizontal', {
      endpoint: 'getTrade',
      idorContext: { sourceRole: 'user-a', targetRole: 'user-b', resourceField: 'tradeId', resourceValue: 'abc' },
    });
    const b = make('idor_horizontal', {
      endpoint: 'getTrade',
      idorContext: { sourceRole: 'user-x', targetRole: 'user-y', resourceField: 'tradeId', resourceValue: 'def' },
    });
    // Same toolId+field collapses into one cluster
    expect(clusterSignature(a)).toBe(clusterSignature(b));
  });

  it('vulnerable_dependency_high uses advisoryId', () => {
    const a = make('vulnerable_dependency_high', {
      staticContext: { tool: 'npm-audit', ruleId: '1234', sourceFile: 'package-lock.json' },
    });
    const b = make('vulnerable_dependency_high', {
      staticContext: { tool: 'npm-audit', ruleId: '5678', sourceFile: 'package-lock.json' },
    });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
    expect(clusterSignature(a)).toContain('1234');
  });

  it('hardcoded_credentials_in_source uses file + line', () => {
    const a = make('hardcoded_credentials_in_source', {
      staticContext: { tool: 'gitleaks', ruleId: 'generic-api-key', sourceFile: 'src/config.ts', sourceLine: 42 },
    });
    const b = make('hardcoded_credentials_in_source', {
      staticContext: { tool: 'gitleaks', ruleId: 'generic-api-key', sourceFile: 'src/config.ts', sourceLine: 43 },
    });
    // Different lines → different signatures
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('hydration_mismatch uses message+stack like react_error', () => {
    const a = make('hydration_mismatch', { rootCause: 'Hydration failed' });
    const sig = clusterSignature(a);
    expect(sig.startsWith('hydration_mismatch|')).toBe(true);
  });

  it('all new kinds return a non-empty string', () => {
    const kinds: BugDetection['kind'][] = [
      'missing_csp_header', 'permissive_cors', 'cookie_security_flags',
      'csrf_missing_on_mutating_route', 'open_redirect', 'sensitive_data_in_url',
      'stack_trace_leak_in_response', 'vulnerable_dependency_high',
      'hardcoded_credentials_in_source', 'swallowed_error_empty_catch',
      'idor_horizontal', 'idor_vertical_role_escalate', 'auth_bypass_via_unauthed_route',
      'no_rate_limit_on_login', 'race_double_submit', 'optimistic_update_divergence',
      'hallucinated_route', 'hydration_mismatch',
    ];
    for (const kind of kinds) {
      const sig = clusterSignature(make(kind));
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toContain('|');
    }
  });
});
