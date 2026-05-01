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
      'no_rate_limit_on_login',
      'race_condition_double_submit', 'race_condition_click_navigate',
      'race_condition_optimistic_revert', 'race_condition_interleaved_mutations',
      'race_condition_cross_tab',
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

describe('clusterSignature — v0.12 interactive_element_missing_accessible_name', () => {
  it('5 occurrences on same page+selector collapse into 1 cluster key', () => {
    const detection = make('interactive_element_missing_accessible_name', {
      pageRoute: '/?setTab=settings',
      selectorClass: 'button[aria-label="Refresh AI usage history"]',
    });
    const sigs = Array.from({ length: 5 }, () => clusterSignature(detection));
    expect(new Set(sigs).size).toBe(1);
  });

  it('3 occurrences on different pages produce 3 distinct cluster keys', () => {
    const pages = ['/', '/?setTab=settings', '/onboarding'];
    const sigs = pages.map(page =>
      clusterSignature(make('interactive_element_missing_accessible_name', {
        pageRoute: page,
        selectorClass: 'button:nth-of-type(3)',
      })),
    );
    expect(new Set(sigs).size).toBe(3);
  });

  it('2 occurrences with different selectorClass on same page produce 2 cluster keys', () => {
    const a = make('interactive_element_missing_accessible_name', {
      pageRoute: '/',
      selectorClass: 'button:nth-of-type(3)',
    });
    const b = make('interactive_element_missing_accessible_name', {
      pageRoute: '/',
      selectorClass: 'button[onclick]',
    });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('signature includes pageRoute and selectorClass', () => {
    const sig = clusterSignature(make('interactive_element_missing_accessible_name', {
      pageRoute: '/dashboard',
      selectorClass: 'button.icon',
    }));
    expect(sig).toContain('/dashboard');
    expect(sig).toContain('button.icon');
    expect(sig).toContain('interactive_element_missing_accessible_name');
  });
});

describe('clusterSignature — v0.17 visual_anomaly viewport clustering', () => {
  it('same description at different viewports produces distinct cluster keys', () => {
    const base = { kind: 'visual_anomaly' as const, rootCause: 'table clipped on right edge', visualCategory: 'layout' as const };
    const at375 = make('visual_anomaly', { ...base, visualContext: { viewportPx: 375 } });
    const at1280 = make('visual_anomaly', { ...base, visualContext: { viewportPx: 1280 } });
    expect(clusterSignature(at375)).not.toBe(clusterSignature(at1280));
  });

  it('same description at same viewport produces identical cluster keys', () => {
    const base = { rootCause: 'table clipped on right edge', visualCategory: 'layout' as const };
    const a = make('visual_anomaly', { ...base, visualContext: { viewportPx: 375 } });
    const b = make('visual_anomaly', { ...base, visualContext: { viewportPx: 375 } });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
  });

  it('cluster key contains the viewport px value', () => {
    const sig = clusterSignature(make('visual_anomaly', {
      rootCause: 'menu overflow',
      visualCategory: 'layout',
      visualContext: { viewportPx: 768 },
    }));
    expect(sig).toContain('768');
    expect(sig).toContain('visual_anomaly');
  });

  it('missing viewportPx falls back to unknown in cluster key', () => {
    const sig = clusterSignature(make('visual_anomaly', {
      rootCause: 'missing alt text',
      visualCategory: 'a11y',
    }));
    expect(sig).toContain('unknown');
  });
});

describe('clusterSignature — v0.22 nav-state kinds', () => {
  it('nav_state_corruption clusters by pageRoute + transitionKind + mismatchKind + seedActionKind', () => {
    const a = make('nav_state_corruption', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'back', mismatchKind: 'dom', seedActionKind: 'click' },
    });
    const b = make('nav_state_corruption', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'back', mismatchKind: 'dom', seedActionKind: 'click' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('nav_state_corruption|/orders|back|dom|click');
  });

  it('nav_state_corruption: different transitionKind → different cluster', () => {
    const a = make('nav_state_corruption', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'back', mismatchKind: 'dom' },
    });
    const b = make('nav_state_corruption', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'refresh', mismatchKind: 'dom' },
    });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('nav_resubmit_on_back clusters by pageRoute + endpoint', () => {
    const a = make('nav_resubmit_on_back', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'back', endpoint: 'POST /api/orders' },
    });
    const b = make('nav_resubmit_on_back', {
      pageRoute: '/orders',
      navStateContext: { transitionKind: 'back', endpoint: 'POST /api/orders' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('nav_resubmit_on_back|/orders|POST /api/orders');
  });

  it('nav_resubmit_on_back: two detections with same endpoint collapse to one cluster', () => {
    const detections = [
      make('nav_resubmit_on_back', {
        pageRoute: '/checkout',
        navStateContext: { transitionKind: 'back', endpoint: 'POST /api/checkout' },
      }),
      make('nav_resubmit_on_back', {
        pageRoute: '/checkout',
        navStateContext: { transitionKind: 'back', endpoint: 'POST /api/checkout' },
      }),
    ];
    const sigs = detections.map(clusterSignature);
    expect(new Set(sigs).size).toBe(1);
  });

  it('nav_refresh_double_mutation clusters by pageRoute + endpoint', () => {
    const a = make('nav_refresh_double_mutation', {
      pageRoute: '/payment',
      navStateContext: { transitionKind: 'refresh', endpoint: 'POST /api/pay' },
    });
    const b = make('nav_refresh_double_mutation', {
      pageRoute: '/payment',
      navStateContext: { transitionKind: 'refresh', endpoint: 'POST /api/pay' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('nav_refresh_double_mutation|/payment|POST /api/pay');
  });

  it('nav_form_state_lost clusters by pageRoute + formSignature', () => {
    const a = make('nav_form_state_lost', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text|email:email' },
    });
    const b = make('nav_form_state_lost', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text|email:email' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('nav_form_state_lost|/profile|name:text|email:email');
  });

  it('nav_form_state_stale clusters by pageRoute + formSignature + staleField', () => {
    const a = make('nav_form_state_stale', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text', staleField: 'name' },
    });
    const b = make('nav_form_state_stale', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text', staleField: 'name' },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
    expect(clusterSignature(a)).toBe('nav_form_state_stale|/profile|name:text|name');
  });

  it('nav_form_state_stale: different staleField produces different cluster', () => {
    const a = make('nav_form_state_stale', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text|bio:text', staleField: 'name' },
    });
    const b = make('nav_form_state_stale', {
      pageRoute: '/profile',
      navStateContext: { transitionKind: 'back', formSignature: 'name:text|bio:text', staleField: 'bio' },
    });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('all nav-state kinds return non-empty strings with pipe separators', () => {
    const navKinds: BugDetection['kind'][] = [
      'nav_state_corruption',
      'nav_resubmit_on_back',
      'nav_refresh_double_mutation',
      'nav_form_state_lost',
      'nav_form_state_stale',
    ];
    for (const kind of navKinds) {
      const sig = clusterSignature(make(kind));
      expect(sig.length).toBeGreaterThan(0);
      expect(sig).toContain('|');
    }
  });
});

// v0.39 — Cluster-stability invariant: two fuzz draws with different input values
// but identical downstream effect MUST cluster identically.
describe('clusterSignature — v0.39 fuzz stability', () => {
  it('network_5xx with different triggeringAction.input values collapse to same cluster', () => {
    const sharedFields = {
      endpoint: 'POST /api/users',
      status: 500,
      responseBodyShape: '{"error":"Internal Server Error"}',
    };
    const a = make('network_5xx', {
      ...sharedFields,
      triggeringAction: {
        kind: 'api_call' as const,
        via: 'api' as const,
        expectedOutcome: 'expected_failure' as const,
        palette: 'fuzz' as const,
        toolId: 'createUser',
        input: { name: '‮Admin ' },
      },
    });
    const b = make('network_5xx', {
      ...sharedFields,
      triggeringAction: {
        kind: 'api_call' as const,
        via: 'api' as const,
        expectedOutcome: 'expected_failure' as const,
        palette: 'fuzz' as const,
        toolId: 'createUser',
        input: { name: '​​x' },
      },
    });
    // clusterSignature ignores triggeringAction.input — must produce identical keys
    expect(clusterSignature(a)).toBe(clusterSignature(b));
  });

  it('network_5xx with different endpoints produce different clusters', () => {
    const a = make('network_5xx', { endpoint: 'POST /api/users', status: 500, responseBodyShape: 'err' });
    const b = make('network_5xx', { endpoint: 'POST /api/orders', status: 500, responseBodyShape: 'err' });
    expect(clusterSignature(a)).not.toBe(clusterSignature(b));
  });

  it('console_error with different fuzz inputs collapse when message matches', () => {
    const sharedCause = "Cannot read properties of undefined (reading 'id')";
    const a = make('console_error', {
      rootCause: sharedCause,
      triggeringAction: {
        kind: 'api_call' as const,
        via: 'api' as const,
        expectedOutcome: 'expected_failure' as const,
        palette: 'fuzz' as const,
        input: { x: '\x00' },
      },
    });
    const b = make('console_error', {
      rootCause: sharedCause,
      triggeringAction: {
        kind: 'api_call' as const,
        via: 'api' as const,
        expectedOutcome: 'expected_failure' as const,
        palette: 'fuzz' as const,
        input: { x: '中文' },
      },
    });
    expect(clusterSignature(a)).toBe(clusterSignature(b));
  });
});
