// Cluster signature derivation per § 3.6 (extended for v0.5 security kinds).
//
// v0.39 fuzz-stability invariant: triggeringAction.input (and TestCase.fuzzMeta) are
// NEVER included in cluster signatures. Two fuzz draws that produce different input values
// but hit the same endpoint / error / status MUST produce identical cluster keys.
// This ensures stochastic discoveries collapse to one cluster across re-runs.
// Verified by the test suite in signature.test.ts ("v0.39 fuzz stability" describe block).

import type { BugDetection, BugKind } from '../types.js';
import { normalizeErrorMessage, fingerprintStackTrace, shapeResponseBody } from './normalize.js';
import { normalizePath } from '../classify/network.js';

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
      // v0.17: include viewport so mobile and desktop bugs cluster separately.
      const vp = detection.visualContext?.viewportPx ?? 'unknown';
      return `${detection.kind}|${cat}|${vp}|${descNorm}`;
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

    // v0.21 IDOR kinds — keyed on resourceType, not toolId, so multiple tools on
    // the same resource collapse to one cluster.
    case 'idor_horizontal_read':
    case 'idor_horizontal_mutate': {
      const resourceType = detection.idorContext?.resourceType ?? '';
      const tier = detection.idorContext?.tier ?? 'unknown';
      return `${detection.kind}|${resourceType}|${tier}`;
    }
    case 'idor_vertical_suspicious': {
      const resourceType = detection.idorContext?.resourceType ?? '';
      const sourceTier = detection.idorContext?.sourceTier ?? '';
      const targetTier = detection.idorContext?.targetTier ?? '';
      return `idor_vertical_suspicious|${resourceType}|${sourceTier}->${targetTier}`;
    }

    // IDOR cross-user (legacy v0.5 — kept for backward compat with old artifacts)
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

    // v0.19 race-condition kinds
    case 'race_condition_double_submit': {
      const tool = detection.endpoint ?? '';
      return `race_condition_double_submit|${tool}|${detection.raceContext?.gapMs ?? ''}`;
    }
    case 'race_condition_click_navigate': {
      const route = detection.pageRoute ?? '';
      const target = detection.raceContext?.navigateTarget ?? '';
      const proof = detection.raceContext?.proof ?? '';
      return `race_condition_click_navigate|${route}|${target}|${proof}`;
    }
    case 'race_condition_optimistic_revert': {
      const tool = detection.endpoint ?? '';
      return `race_condition_optimistic_revert|${tool}`;
    }
    case 'race_condition_interleaved_mutations': {
      const tool = detection.endpoint ?? '';
      const sibling = detection.raceContext?.siblingToolId ?? '';
      return `race_condition_interleaved_mutations|${tool}|${sibling}`;
    }
    case 'race_condition_cross_tab': {
      const tool = detection.endpoint ?? '';
      return `race_condition_cross_tab|${tool}`;
    }

    // v0.40 multi-context kinds
    case 'multi_context_state_divergence': {
      const tool = detection.endpoint ?? '';
      const n = detection.multiContextContext?.n ?? '';
      return `multi_context_state_divergence|${tool}|n=${n}`;
    }
    case 'visibility_change_state_loss': {
      const tool = detection.endpoint ?? '';
      const lifecycleEvent = detection.multiContextContext?.lifecycleEvent ?? '';
      const proof = detection.multiContextContext?.proof ?? '';
      return `visibility_change_state_loss|${tool}|${lifecycleEvent}|${proof}`;
    }
    case 'multi_user_inconsistent_snapshot': {
      const writer = detection.endpoint ?? '';
      const reader = detection.multiContextContext?.readerEndpoint ?? '';
      return `multi_user_inconsistent_snapshot|${writer}|${reader}`;
    }

    // Hallucinated route
    case 'hallucinated_route':
      return `hallucinated_route|${detection.targetPath ?? ''}`;

    // v0.16 active pen-testing kinds
    case 'sql_injection':
      return `sql_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}|${detection.injectionContext?.variant ?? ''}`;
    case 'command_injection':
      return `command_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
    case 'path_traversal':
      return `path_traversal|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
    case 'jwt_weak_alg':
      return `jwt_weak_alg|${detection.endpoint ?? ''}|${detection.injectionContext?.proof ?? ''}`;

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

    // v0.6 performance kinds
    case 'slow_lcp':
      return `${detection.pageRoute ?? ''}:slow_lcp`;
    case 'slow_inp':
      return `${detection.pageRoute ?? ''}:slow_inp`;
    case 'high_cls':
      return `${detection.pageRoute ?? ''}:high_cls`;
    case 'unbounded_list_render': {
      const sel = (detection.evidence as { containerSelector?: string } | undefined)?.containerSelector ?? '';
      return `${detection.pageRoute ?? ''}:${sel}:unbounded_list_render`;
    }
    case 'n_plus_one_api_calls': {
      const ep = (detection.evidence as { endpointFamily?: string } | undefined)?.endpointFamily ?? detection.endpoint ?? '';
      return `${ep}:n_plus_one_api_calls`;
    }
    case 'request_dedup_missing': {
      const method = (detection.evidence as { method?: string } | undefined)?.method ?? '';
      const url = (detection.evidence as { url?: string } | undefined)?.url ?? '';
      return `${method}:${normalizePath(url)}:request_dedup_missing`;
    }
    case 'request_cancellation_missing': {
      const method = (detection.evidence as { method?: string } | undefined)?.method ?? '';
      const url = (detection.evidence as { url?: string } | undefined)?.url ?? '';
      return `${method}:${normalizePath(url)}:request_cancellation_missing`;
    }
    case 'main_thread_blocked':
      return `${detection.pageRoute ?? ''}:main_thread_blocked`;
    case 'oversized_bundle': {
      const kind = (detection.evidence as { kind?: string } | undefined)?.kind ?? '';
      return `oversized_bundle:${kind}`;
    }
    case 'excessive_re_renders': {
      const comp = (detection.evidence as { component?: string } | undefined)?.component ?? '';
      return `${comp}:excessive_re_renders`;
    }
    case 'memory_leak_suspected':
      return 'memory_leak_suspected:run';
    case 'memory_leak_attributed': {
      const chain = detection.heapContext?.retainerChain;
      const retainerFirst = chain !== undefined && chain.length > 0 ? chain[0] : '';
      return `memory_leak_attributed|${detection.heapContext?.constructorName ?? ''}|${retainerFirst}`;
    }

    // v0.6 a11y baseline kinds
    case 'axe_color_contrast_strong':
      return `axe_color_contrast_strong|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'keyboard_trap':
      return `keyboard_trap|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'focus_lost_after_action':
      return `focus_lost_after_action|${detection.pageRoute ?? ''}|${detection.a11yContext?.triggeringSelector ?? detection.selectorClass ?? ''}`;
    case 'image_missing_alt':
      return `image_missing_alt|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'form_input_unlabeled':
      return `form_input_unlabeled|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    // v0.12 click-evaluate kinds
    case 'interactive_element_missing_accessible_name':
      return `interactive_element_missing_accessible_name|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;

    // v0.6 SEO hygiene kinds
    case 'seo_title_missing':
      return `seo_title_missing|${detection.pageRoute ?? ''}`;
    case 'seo_title_duplicate_across_routes': {
      const title = detection.seoContext?.observedValue ?? '';
      return `seo_title_duplicate_across_routes|${title}`;
    }
    case 'seo_meta_description_missing':
      return `seo_meta_description_missing|${detection.pageRoute ?? ''}`;
    case 'seo_canonical_missing':
      return `seo_canonical_missing|${detection.pageRoute ?? ''}`;
    case 'seo_h1_missing_or_multiple': {
      const h1Count = detection.seoContext?.observedValue ?? '';
      return `seo_h1_missing_or_multiple|${detection.pageRoute ?? ''}|${h1Count}`;
    }
    case 'seo_robots_blocking_crawl':
      return `seo_robots_blocking_crawl|${detection.pageRoute ?? ''}`;

    // v0.23 clock-injection kinds
    case 'clock_dst_corruption':
      return `clock_dst_corruption|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.condition ?? ''}`;
    case 'clock_leap_day_failure':
      return `clock_leap_day_failure|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.proof ?? ''}`;
    case 'clock_skew_token_invalid':
      return `clock_skew_token_invalid|${detection.endpoint ?? ''}|${detection.clockContext?.condition ?? ''}`;
    case 'clock_timezone_display':
      return `clock_timezone_display|${detection.pageRoute ?? ''}|${detection.clockContext?.injectedTimezone ?? ''}`;
    case 'clock_overflow':
      return `clock_overflow|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.condition ?? ''}`;

    // v0.22 nav-state kinds (§4.2)

    // nav_state_corruption: pageRoute + transition.kind + mismatchKind + seed.action.kind
    case 'nav_state_corruption': {
      const transitionKind = detection.navStateContext?.transitionKind ?? '';
      const mismatchKind = detection.navStateContext?.mismatchKind ?? '';
      const seedKind = detection.navStateContext?.seedActionKind ?? '';
      return `nav_state_corruption|${detection.pageRoute ?? ''}|${transitionKind}|${mismatchKind}|${seedKind}`;
    }

    // nav_resubmit_on_back: pageRoute + endpoint (method + normalized path)
    case 'nav_resubmit_on_back': {
      const endpoint = detection.navStateContext?.endpoint ?? detection.endpoint ?? '';
      return `nav_resubmit_on_back|${detection.pageRoute ?? ''}|${endpoint}`;
    }

    // nav_refresh_double_mutation: pageRoute + endpoint (method + normalized path)
    case 'nav_refresh_double_mutation': {
      const endpoint = detection.navStateContext?.endpoint ?? detection.endpoint ?? '';
      return `nav_refresh_double_mutation|${detection.pageRoute ?? ''}|${endpoint}`;
    }

    // nav_form_state_lost: pageRoute + formSignature
    case 'nav_form_state_lost': {
      const formSig = detection.navStateContext?.formSignature ?? '';
      return `nav_form_state_lost|${detection.pageRoute ?? ''}|${formSig}`;
    }

    // nav_form_state_stale: pageRoute + formSignature + staleField
    case 'nav_form_state_stale': {
      const formSig = detection.navStateContext?.formSignature ?? '';
      const staleField = detection.navStateContext?.staleField ?? '';
      return `nav_form_state_stale|${detection.pageRoute ?? ''}|${formSig}|${staleField}`;
    }


    // v0.36 browser-platform kinds

    case 'service_worker_stale':
      return `service_worker_stale|${detection.pageRoute ?? ''}`;
    case 'web_worker_error': {
      const scriptUrl = detection.browserPlatformContext?.kind === 'worker'
        ? detection.browserPlatformContext.scriptUrl
        : '';
      return `web_worker_error|${detection.pageRoute ?? ''}|${scriptUrl}`;
    }
    case 'iframe_postmessage_unguarded':
      return `iframe_postmessage_unguarded|${detection.pageRoute ?? ''}`;
    case 'shadow_dom_a11y_violation': {
      const ctx = detection.browserPlatformContext;
      const host = ctx?.kind === 'shadow_a11y' ? hostTagNameOf(ctx.hostSelector) : '';
      const rule = ctx?.kind === 'shadow_a11y' ? ctx.axeRuleId : '';
      return `shadow_dom_a11y_violation|${detection.pageRoute ?? ''}|${host}|${rule}`;
    }
    case 'permission_denied_unhandled': {
      const perm = detection.browserPlatformContext?.kind === 'permission'
        ? detection.browserPlatformContext.permission
        : '';
      return `permission_denied_unhandled|${detection.pageRoute ?? ''}|${perm}`;
    }
    case 'webrtc_ice_failure':
      return `webrtc_ice_failure|${detection.pageRoute ?? ''}`;
    case 'subresource_integrity_violation': {
      const blockedUrl = detection.browserPlatformContext?.kind === 'sri'
        ? detection.browserPlatformContext.blockedUrl
        : '';
      return `subresource_integrity_violation|${detection.pageRoute ?? ''}|${blockedUrl}`;
    }
    case 'coop_coep_violation':
      return `coop_coep_violation|${detection.pageRoute ?? ''}`;
    case 'trusted_types_violation': {
      const blockedURI = detection.browserPlatformContext?.kind === 'trusted_types'
        ? detection.browserPlatformContext.blockedURI
        : '';
      return `trusted_types_violation|${detection.pageRoute ?? ''}|${blockedURI}`;
    }

    // v0.20 network-fault kinds: route + selectorClass + action + variant
    case 'network_fault_unhandled': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `network_fault_unhandled|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }
    case 'network_fault_optimistic_no_revert': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `network_fault_optimistic_no_revert|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }
    case 'infinite_loading': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `infinite_loading|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }

    // v0.43 agentic-app detection kinds

    case 'agent_response_hallucinated': {
      const claimNorm = normalizeAgentClaim(detection.agentContext?.proof?.kind === 'unsupported_claim' ? detection.agentContext.proof.claim : '');
      return `agent_response_hallucinated|${detection.endpoint ?? ''}|${claimNorm}`;
    }
    case 'agent_action_timeout':
      return `agent_action_timeout|${detection.endpoint ?? ''}`;
    case 'prompt_injection_executed':
      return `prompt_injection_executed|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}|${detection.injectionContext?.variant ?? ''}`;
    case 'streaming_response_truncated': {
      const reason = detection.agentContext?.proof?.kind === 'truncated' ? detection.agentContext.proof.reason : 'unknown';
      return `streaming_response_truncated|${detection.endpoint ?? ''}|${reason}`;
    }
    case 'tool_call_failure_unhandled': {
      const toolEndpoint = detection.agentContext?.proof?.kind === 'silent_failure' ? detection.agentContext.proof.toolEndpoint : '';
      return `tool_call_failure_unhandled|${toolEndpoint}`;
    }
    case 'agent_cost_per_turn_high':
      return `agent_cost_per_turn_high|${detection.endpoint ?? ''}|${detection.agentContext?.modelId ?? 'unknown'}`;
    // v37 i18n / locale stress kinds
    case 'i18n_rtl_layout_break':
    case 'i18n_long_string_overflow':
    case 'i18n_date_format_ambiguous':
    case 'i18n_pluralization_broken':
    case 'i18n_currency_format_broken':
    case 'i18n_timezone_display_wrong': {
      const sel = detection.selectorClass ?? '';
      return `${detection.kind}|${detection.pageRoute ?? ''}|${sel}`;
    }

    case 'i18n_hardcoded_string': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = String(detection.staticContext?.sourceLine ?? '');
      return `i18n_hardcoded_string|${file}|${line}`;
    }

  }
}

function hostTagNameOf(selector: string): string {
  const match = /^([a-z][a-z0-9-]*)/i.exec(selector);
  return match !== null ? match[1].toLowerCase() : selector;
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

/**
 * Normalize an agent claim for clustering:
 * 1. Lowercase
 * 2. Strip quoted strings
 * 3. Take first 8 words, joined with '-'
 * Mirrors normalizeVisualDescription shape (§ 8.1).
 */
export function normalizeAgentClaim(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/["'`][^"'`]*["'`]/g, '');
  const words = s.split(/\W+/).filter(w => w.length > 0).slice(0, 8);
  return words.join('-');
}

export { shapeResponseBody };
