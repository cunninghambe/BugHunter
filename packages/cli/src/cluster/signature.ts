// Cluster signature derivation per § 3.6 (extended for v0.5 security kinds).

import type { BugDetection, BugKind } from '../types.js';
import { normalizeErrorMessage, fingerprintStackTrace, shapeResponseBody } from './normalize.js';

export type ClusterKey = string;

export function clusterSignature(detection: BugDetection): ClusterKey {
  switch (detection.kind) {
    case 'console_error':
    case 'react_error':
    case 'hydration_mismatch':
    case 'unhandled_exception': {
      const msgNorm = normalizeErrorMessage(detection.rootCause);
      const stackFp = detection.stackTrace !== undefined ? fingerprintStackTrace(detection.stackTrace) : '';
      return `${detection.kind}|${msgNorm}|${stackFp}`;
    }
    case 'network_5xx':
    case 'network_4xx_unexpected': {
      const bodyShape = detection.responseBodyShape ?? '';
      return `${detection.kind}|${detection.endpoint ?? ''}|${detection.status ?? ''}|${bodyShape}`;
    }
    case 'missing_state_change':
    case 'dom_error_text': {
      const actionKind = detection.triggeringAction?.kind ?? '';
      return `${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${actionKind}`;
    }
    case '404_for_linked_route':
      return `${detection.kind}|${detection.targetPath ?? ''}`;
    case 'surface_call_failed':
      return `${detection.kind}|${detection.endpoint ?? ''}`;
    case 'accessibility_critical':
      return `${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'visual_anomaly': {
      const cat = detection.visualCategory ?? 'other';
      const descNorm = normalizeVisualDescription(detection.rootCause);
      return `${detection.kind}|${cat}|${descNorm}`;
    }

    // --- v0.5 security kinds ---

    // Header-probe: one cluster per origin
    case 'missing_csp_header': {
      const origin = detection.headerContext?.observedValue ?? detection.endpoint ?? '';
      return `missing_csp_header|${origin}`;
    }
    // CORS: per route + rule-variant
    case 'permissive_cors': {
      const route = detection.endpoint ?? '';
      const rule = detection.headerContext?.expectedShape ?? '';
      return `permissive_cors|${route}|${rule}`;
    }
    // Cookie flags: per cookie name + missing flag
    case 'cookie_security_flags': {
      const cookieName = detection.headerContext?.headerName ?? '';
      const missingFlag = detection.headerContext?.expectedShape ?? '';
      return `cookie_security_flags|${cookieName}|${missingFlag}`;
    }
    // CSRF: per toolId / route
    case 'csrf_missing_on_mutating_route':
      return `csrf_missing_on_mutating_route|${detection.endpoint ?? ''}`;
    // Open redirect: per route + param name
    case 'open_redirect': {
      const paramName = detection.headerContext?.headerName ?? '';
      return `open_redirect|${detection.endpoint ?? ''}|${paramName}`;
    }
    // Sensitive URL param: per route + param name
    case 'sensitive_data_in_url': {
      const paramName = detection.headerContext?.headerName ?? '';
      return `sensitive_data_in_url|${detection.endpoint ?? ''}|${paramName}`;
    }
    // Stack trace leak: per route + frame fingerprint
    case 'stack_trace_leak_in_response': {
      const fingerprint = detection.headerContext?.expectedShape ?? '';
      return `stack_trace_leak_in_response|${detection.endpoint ?? ''}|${fingerprint}`;
    }

    // Static analysis: per advisory id
    case 'vulnerable_dependency_high': {
      const ruleId = detection.staticContext?.ruleId ?? '';
      return `vulnerable_dependency_high|${ruleId}`;
    }
    // Static analysis: per source file + line
    case 'hardcoded_credentials_in_source': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = detection.staticContext?.sourceLine ?? '';
      return `hardcoded_credentials_in_source|${file}|${line}`;
    }
    case 'swallowed_error_empty_catch': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = detection.staticContext?.sourceLine ?? '';
      return `swallowed_error_empty_catch|${file}|${line}`;
    }

    // IDOR cross-user
    case 'idor_horizontal': {
      const toolId = detection.endpoint ?? '';
      const field = detection.idorContext?.resourceField ?? '';
      return `idor_horizontal|${toolId}|${field}`;
    }
    case 'idor_vertical_role_escalate': {
      const toolId = detection.endpoint ?? '';
      const role = detection.idorContext?.targetRole ?? '';
      return `idor_vertical_role_escalate|${toolId}|${role}`;
    }
    case 'auth_bypass_via_unauthed_route':
      return `auth_bypass_via_unauthed_route|${detection.endpoint ?? ''}`;

    // Auth probe
    case 'no_rate_limit_on_login':
      return `no_rate_limit_on_login|${detection.endpoint ?? ''}`;

    // Synthetic
    case 'race_double_submit': {
      const formSig = detection.headerContext?.expectedShape ?? '';
      return `race_double_submit|${detection.endpoint ?? ''}|${formSig}`;
    }
    case 'optimistic_update_divergence':
      return `optimistic_update_divergence|${detection.endpoint ?? ''}|${detection.status ?? ''}`;

    // Hallucinated route
    case 'hallucinated_route':
      return `hallucinated_route|${detection.targetPath ?? ''}`;

    // v0.7 XSS kinds
    case 'xss_reflected': {
      const route = detection.endpoint ?? detection.pageRoute ?? '';
      const field = detection.xssContext?.fieldName ?? '';
      return `xss_reflected|${route}|${field}`;
    }
    case 'xss_dom': {
      const route = detection.pageRoute ?? '';
      const field = detection.xssContext?.fieldName ?? '';
      const sink = detection.xssContext?.sink ?? '';
      return `xss_dom|${route}|${field}|${sink}`;
    }
    case 'xss_stored':
      // v0.8 placeholder — never fires in v0.7. Kept for cluster-collation forward-compat.
      return `xss_stored|${detection.endpoint ?? ''}|${detection.xssContext?.fieldName ?? ''}`;

    // v0.7 auth-flow kinds
    case 'auth_session_fixation': {
      const cookie = detection.authFlowContext?.cookieName ?? '';
      return `auth_session_fixation|${cookie}`;
    }
    case 'password_reset_token_reuse':
      return `password_reset_token_reuse|${detection.endpoint ?? ''}`;
  }
}

export function extractNormalizedFields(detection: BugDetection): {
  errorMessageNormalized?: string;
  stackTraceFingerprint?: string;
} {
  const isMessageBased = (k: BugKind) =>
    k === 'console_error' || k === 'react_error' || k === 'unhandled_exception' || k === 'hydration_mismatch';

  if (isMessageBased(detection.kind) !== true) return {};
  return {
    errorMessageNormalized: normalizeErrorMessage(detection.rootCause),
    stackTraceFingerprint: detection.stackTrace !== undefined ? fingerprintStackTrace(detection.stackTrace) : undefined,
  };
}

/**
 * Normalize a visual anomaly description for clustering:
 * 1. Lowercase
 * 2. Strip route paths (/word/...) and bare numbers >= 4 digits
 * 3. Strip quoted strings (single, double, backtick)
 * 4. Take first 8 words, joined with '-'
 */
export function normalizeVisualDescription(text: string): string {
  let s = text.toLowerCase();
  // Strip route paths (e.g. /dashboard, /trades/123)
  s = s.replace(/\/[a-z0-9_/-]+/g, '');
  // Strip bare numbers >= 4 digits
  s = s.replace(/\b\d{4,}\b/g, '');
  // Strip quoted strings
  s = s.replace(/["'`][^"'`]*["'`]/g, '');
  // Tokenize to words and take first 8
  const words = s.split(/\W+/).filter(w => w.length > 0).slice(0, 8);
  return words.join('-');
}

export { shapeResponseBody };
