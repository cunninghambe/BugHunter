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

describe('clusterSignature — v0.7 XSS kinds', () => {
  it('xss_reflected collapses by route + fieldName', () => {
    const a = make('xss_reflected', {
      endpoint: '/login',
      xssContext: { variant: 'script_tag_basic', injectionPoint: 'url_param', fieldName: 'next', sink: 'reflected_html', nonce: 'aaa111aaa111aaa1' },
    });
    const b = make('xss_reflected', {
      endpoint: '/login',
      xssContext: { variant: 'img_onerror', injectionPoint: 'url_param', fieldName: 'next', sink: 'reflected_attr', nonce: 'bbb222bbb222bbb2' },
    });
    // Same route+field → same signature despite different nonces
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('xss_reflected|/login|next');
  });

  it('xss_reflected differs by field name', () => {
    const a = make('xss_reflected', {
      endpoint: '/search',
      xssContext: { variant: 'script_tag_basic', injectionPoint: 'url_param', fieldName: 'q', sink: 'reflected_html', nonce: 'aaa111aaa111aaa1' },
    });
    const b = make('xss_reflected', {
      endpoint: '/search',
      xssContext: { variant: 'script_tag_basic', injectionPoint: 'url_param', fieldName: 'redirect', sink: 'reflected_html', nonce: 'aaa111aaa111aaa1' },
    });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('xss_dom collapses by pageRoute + field + sink', () => {
    const a = make('xss_dom', {
      pageRoute: '/dashboard',
      xssContext: { variant: 'img_onerror', injectionPoint: 'form_field', fieldName: 'comment', sink: 'dom_inserted', nonce: 'aaa111aaa111aaa1' },
    });
    const b = make('xss_dom', {
      pageRoute: '/dashboard',
      xssContext: { variant: 'svg_onload', injectionPoint: 'form_field', fieldName: 'comment', sink: 'dom_inserted', nonce: 'bbb222bbb222bbb2' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('xss_dom|/dashboard|comment|dom_inserted');
  });

  it('xss_stored returns a stable placeholder signature', () => {
    const sig = clusterSignature(make('xss_stored', {
      endpoint: '/api/comments',
      xssContext: { variant: 'script_tag_basic', injectionPoint: 'json_body', fieldName: 'body', sink: 'reflected_html', nonce: 'aaa111aaa111aaa1' },
    }));
    expect(sig).toBe('xss_stored|/api/comments|body');
  });

  it('all XSS kinds return non-empty strings with pipes', () => {
    for (const kind of ['xss_reflected', 'xss_dom', 'xss_stored'] as BugDetection['kind'][]) {
      const sig = clusterSignature(make(kind));
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toContain('|');
    }
  });
});

describe('clusterSignature — v0.7 auth-flow kinds', () => {
  it('auth_session_fixation collapses by cookie name', () => {
    const a = make('auth_session_fixation', {
      authFlowContext: { invariant: 'session_id_rotates', cookieName: 'tj_sess', preValuePrefix: 'abc12345', postValuePrefix: 'abc12345' },
    });
    const b = make('auth_session_fixation', {
      authFlowContext: { invariant: 'session_id_rotates', cookieName: 'tj_sess', preValuePrefix: 'xyzxyzxy', postValuePrefix: 'xyzxyzxy' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('auth_session_fixation|tj_sess');
  });

  it('password_reset_token_reuse collapses by endpoint', () => {
    const a = make('password_reset_token_reuse', {
      endpoint: '/auth/reset',
      authFlowContext: { invariant: 'reset_token_single_use', reuseCount: 2 },
    });
    const b = make('password_reset_token_reuse', {
      endpoint: '/auth/reset',
      authFlowContext: { invariant: 'reset_token_single_use', reuseCount: 2 },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('password_reset_token_reuse|/auth/reset');
  });

  it('all auth-flow kinds return non-empty strings', () => {
    for (const kind of ['auth_session_fixation', 'password_reset_token_reuse'] as BugDetection['kind'][]) {
      const sig = clusterSignature(make(kind));
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toContain('|');
    }
  });
});
