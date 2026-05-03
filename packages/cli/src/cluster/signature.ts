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

/**
 * v0.43+: Kinds where the same finding across surfaces is semantically one cluster.
 * - oversized_bundle: describes the bundle on disk; same file regardless of surface.
 * - memory_leak_suspected: run-scoped sentinel; splitting per-surface is wrong.
 */
export const SURFACE_AGNOSTIC_KINDS: readonly BugKind[] = [
  'oversized_bundle',
  'memory_leak_suspected',
];

function surfacePrefix(detection: BugDetection): string {
  if (SURFACE_AGNOSTIC_KINDS.includes(detection.kind)) return '';
  return `${detection.surface ?? 'unknown'}|`;
}

export function clusterSignature(detection: BugDetection): ClusterKey {
  const pfx = surfacePrefix(detection);
  switch (detection.kind) {
    case 'console_error':
    case 'react_error':
    case 'hydration_mismatch':
    case 'unhandled_exception': {
      const msgNorm = normalizeErrorMessage(detection.rootCause);
      const stackFp = detection.stackTrace !== undefined ? fingerprintStackTrace(detection.stackTrace) : '';
      return `${pfx}${detection.kind}|${msgNorm}|${stackFp}`;
    }
    case 'network_5xx':
    case 'network_4xx_unexpected': {
      const bodyShape = detection.responseBodyShape ?? '';
      return `${pfx}${detection.kind}|${detection.endpoint ?? ''}|${detection.status ?? ''}|${bodyShape}`;
    }
    case 'missing_state_change':
    case 'dom_error_text': {
      const actionKind = detection.triggeringAction?.kind ?? '';
      return `${pfx}${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${actionKind}`;
    }
    case '404_for_linked_route':
      return `${pfx}${detection.kind}|${detection.targetPath ?? ''}`;
    case 'surface_call_failed':
      return `${pfx}${detection.kind}|${detection.endpoint ?? ''}`;
    case 'accessibility_critical':
      return `${pfx}${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'visual_anomaly': {
      const cat = detection.visualCategory ?? 'other';
      const descNorm = normalizeVisualDescription(detection.rootCause);
      // v0.17: include viewport so mobile and desktop bugs cluster separately.
      const vp = detection.visualContext?.viewportPx ?? 'unknown';
      return `${pfx}${detection.kind}|${cat}|${vp}|${descNorm}`;
    }

    // --- v0.5 security kinds ---

    // Header-probe: one cluster per origin
    case 'missing_csp_header': {
      const origin = detection.headerContext?.observedValue ?? detection.endpoint ?? '';
      return `${pfx}missing_csp_header|${origin}`;
    }
    // CORS: per route + rule-variant
    case 'permissive_cors': {
      const route = detection.endpoint ?? '';
      const rule = detection.headerContext?.expectedShape ?? '';
      return `${pfx}permissive_cors|${route}|${rule}`;
    }
    // Cookie flags: per cookie name + missing flag
    case 'cookie_security_flags': {
      const cookieName = detection.headerContext?.headerName ?? '';
      const missingFlag = detection.headerContext?.expectedShape ?? '';
      return `${pfx}cookie_security_flags|${cookieName}|${missingFlag}`;
    }
    // CSRF: per toolId / route
    case 'csrf_missing_on_mutating_route':
      return `${pfx}csrf_missing_on_mutating_route|${detection.endpoint ?? ''}`;
    // Open redirect: per route + param name
    case 'open_redirect': {
      const paramName = detection.headerContext?.headerName ?? '';
      return `${pfx}open_redirect|${detection.endpoint ?? ''}|${paramName}`;
    }
    // Sensitive URL param: per route + param name
    case 'sensitive_data_in_url': {
      const paramName = detection.headerContext?.headerName ?? '';
      return `${pfx}sensitive_data_in_url|${detection.endpoint ?? ''}|${paramName}`;
    }
    // Stack trace leak: per route + frame fingerprint
    case 'stack_trace_leak_in_response': {
      const fingerprint = detection.headerContext?.expectedShape ?? '';
      return `${pfx}stack_trace_leak_in_response|${detection.endpoint ?? ''}|${fingerprint}`;
    }

    // Static analysis: per advisory id
    case 'vulnerable_dependency_high': {
      const ruleId = detection.staticContext?.ruleId ?? '';
      return `${pfx}vulnerable_dependency_high|${ruleId}`;
    }
    // Static analysis: per source file + line
    case 'hardcoded_credentials_in_source': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = detection.staticContext?.sourceLine ?? '';
      return `${pfx}hardcoded_credentials_in_source|${file}|${line}`;
    }
    case 'swallowed_error_empty_catch': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = detection.staticContext?.sourceLine ?? '';
      return `${pfx}swallowed_error_empty_catch|${file}|${line}`;
    }

    // v0.21 IDOR kinds — keyed on resourceType, not toolId, so multiple tools on
    // the same resource collapse to one cluster.
    case 'idor_horizontal_read':
    case 'idor_horizontal_mutate': {
      const resourceType = detection.idorContext?.resourceType ?? '';
      const tier = detection.idorContext?.tier ?? 'unknown';
      return `${pfx}${detection.kind}|${resourceType}|${tier}`;
    }
    case 'idor_vertical_suspicious': {
      const resourceType = detection.idorContext?.resourceType ?? '';
      const sourceTier = detection.idorContext?.sourceTier ?? '';
      const targetTier = detection.idorContext?.targetTier ?? '';
      return `${pfx}idor_vertical_suspicious|${resourceType}|${sourceTier}->${targetTier}`;
    }

    // IDOR cross-user (legacy v0.5 — kept for backward compat with old artifacts)
    case 'idor_horizontal': {
      const toolId = detection.endpoint ?? '';
      const field = detection.idorContext?.resourceField ?? '';
      return `${pfx}idor_horizontal|${toolId}|${field}`;
    }
    case 'idor_vertical_role_escalate': {
      const toolId = detection.endpoint ?? '';
      const role = detection.idorContext?.targetRole ?? '';
      return `${pfx}idor_vertical_role_escalate|${toolId}|${role}`;
    }
    case 'auth_bypass_via_unauthed_route':
      return `${pfx}auth_bypass_via_unauthed_route|${detection.endpoint ?? ''}`;

    // Auth probe
    case 'no_rate_limit_on_login':
      return `${pfx}no_rate_limit_on_login|${detection.endpoint ?? ''}`;

    // v0.19 race-condition kinds
    case 'race_condition_double_submit': {
      const tool = detection.endpoint ?? '';
      return `${pfx}race_condition_double_submit|${tool}|${detection.raceContext?.gapMs ?? ''}`;
    }
    case 'race_condition_click_navigate': {
      const route = detection.pageRoute ?? '';
      const target = detection.raceContext?.navigateTarget ?? '';
      const proof = detection.raceContext?.proof ?? '';
      return `${pfx}race_condition_click_navigate|${route}|${target}|${proof}`;
    }
    case 'race_condition_optimistic_revert': {
      const tool = detection.endpoint ?? '';
      return `${pfx}race_condition_optimistic_revert|${tool}`;
    }
    case 'race_condition_interleaved_mutations': {
      const tool = detection.endpoint ?? '';
      const sibling = detection.raceContext?.siblingToolId ?? '';
      return `${pfx}race_condition_interleaved_mutations|${tool}|${sibling}`;
    }
    case 'race_condition_cross_tab': {
      const tool = detection.endpoint ?? '';
      return `${pfx}race_condition_cross_tab|${tool}`;
    }

    // v0.40 multi-context kinds
    case 'multi_context_state_divergence': {
      const tool = detection.endpoint ?? '';
      const n = detection.multiContextContext?.n ?? '';
      return `${pfx}multi_context_state_divergence|${tool}|n=${n}`;
    }
    case 'visibility_change_state_loss': {
      const tool = detection.endpoint ?? '';
      const lifecycleEvent = detection.multiContextContext?.lifecycleEvent ?? '';
      const proof = detection.multiContextContext?.proof ?? '';
      return `${pfx}visibility_change_state_loss|${tool}|${lifecycleEvent}|${proof}`;
    }
    case 'multi_user_inconsistent_snapshot': {
      const writer = detection.endpoint ?? '';
      const reader = detection.multiContextContext?.readerEndpoint ?? '';
      return `${pfx}multi_user_inconsistent_snapshot|${writer}|${reader}`;
    }

    // Hallucinated route
    case 'hallucinated_route':
      return `${pfx}hallucinated_route|${detection.targetPath ?? ''}`;

    // v0.16 active pen-testing kinds
    case 'sql_injection':
      return `${pfx}sql_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}|${detection.injectionContext?.variant ?? ''}`;
    case 'command_injection':
      return `${pfx}command_injection|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
    case 'path_traversal':
      return `${pfx}path_traversal|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}`;
    case 'jwt_weak_alg':
      return `${pfx}jwt_weak_alg|${detection.endpoint ?? ''}|${detection.injectionContext?.proof ?? ''}`;

    // v0.7 XSS kinds
    case 'xss_reflected': {
      const route = detection.endpoint ?? detection.pageRoute ?? '';
      const field = detection.xssContext?.fieldName ?? '';
      return `${pfx}xss_reflected|${route}|${field}`;
    }
    case 'xss_dom': {
      const route = detection.pageRoute ?? '';
      const field = detection.xssContext?.fieldName ?? '';
      const sink = detection.xssContext?.sink ?? '';
      return `${pfx}xss_dom|${route}|${field}|${sink}`;
    }
    case 'xss_stored':
      // v0.8 placeholder — never fires in v0.7. Kept for cluster-collation forward-compat.
      return `${pfx}xss_stored|${detection.endpoint ?? ''}|${detection.xssContext?.fieldName ?? ''}`;

    // v0.7 auth-flow kinds
    case 'auth_session_fixation': {
      const cookie = detection.authFlowContext?.cookieName ?? '';
      return `${pfx}auth_session_fixation|${cookie}`;
    }
    case 'password_reset_token_reuse':
      return `${pfx}password_reset_token_reuse|${detection.endpoint ?? ''}`;

    // v0.6 performance kinds
    case 'slow_lcp':
      return `${pfx}${detection.pageRoute ?? ''}:slow_lcp`;
    case 'slow_inp':
      return `${pfx}${detection.pageRoute ?? ''}:slow_inp`;
    case 'high_cls':
      return `${pfx}${detection.pageRoute ?? ''}:high_cls`;
    case 'unbounded_list_render': {
      const sel = (detection.evidence as { containerSelector?: string } | undefined)?.containerSelector ?? '';
      return `${pfx}${detection.pageRoute ?? ''}:${sel}:unbounded_list_render`;
    }
    case 'n_plus_one_api_calls': {
      const ep = (detection.evidence as { endpointFamily?: string } | undefined)?.endpointFamily ?? detection.endpoint ?? '';
      return `${pfx}${ep}:n_plus_one_api_calls`;
    }
    case 'request_dedup_missing': {
      const method = (detection.evidence as { method?: string } | undefined)?.method ?? '';
      const url = (detection.evidence as { url?: string } | undefined)?.url ?? '';
      return `${pfx}${method}:${normalizePath(url)}:request_dedup_missing`;
    }
    case 'request_cancellation_missing': {
      const method = (detection.evidence as { method?: string } | undefined)?.method ?? '';
      const url = (detection.evidence as { url?: string } | undefined)?.url ?? '';
      return `${pfx}${method}:${normalizePath(url)}:request_cancellation_missing`;
    }
    case 'main_thread_blocked':
      return `${pfx}${detection.pageRoute ?? ''}:main_thread_blocked`;
    case 'oversized_bundle': {
      // Surface-agnostic: no pfx (same bundle regardless of surface)
      const kind = (detection.evidence as { kind?: string } | undefined)?.kind ?? '';
      return `oversized_bundle:${kind}`;
    }
    case 'excessive_re_renders': {
      const comp = (detection.evidence as { component?: string } | undefined)?.component ?? '';
      return `${pfx}${comp}:excessive_re_renders`;
    }
    case 'memory_leak_suspected':
      // Surface-agnostic: no pfx (run-scoped sentinel)
      return 'memory_leak_suspected:run';
    case 'memory_leak_attributed': {
      const chain = detection.heapContext?.retainerChain;
      const retainerFirst = chain !== undefined && chain.length > 0 ? chain[0] : '';
      return `${pfx}memory_leak_attributed|${detection.heapContext?.constructorName ?? ''}|${retainerFirst}`;
    }

    // v0.6 a11y baseline kinds
    case 'axe_color_contrast_strong':
      return `${pfx}axe_color_contrast_strong|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'keyboard_trap':
      return `${pfx}keyboard_trap|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'focus_lost_after_action':
      return `${pfx}focus_lost_after_action|${detection.pageRoute ?? ''}|${detection.a11yContext?.triggeringSelector ?? detection.selectorClass ?? ''}`;
    case 'image_missing_alt':
      return `${pfx}image_missing_alt|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'form_input_unlabeled':
      return `${pfx}form_input_unlabeled|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    // v0.12 click-evaluate kinds
    case 'interactive_element_missing_accessible_name':
      return `${pfx}interactive_element_missing_accessible_name|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;

    // v0.6 SEO hygiene kinds
    case 'seo_title_missing':
      return `${pfx}seo_title_missing|${detection.pageRoute ?? ''}`;
    case 'seo_title_duplicate_across_routes': {
      const title = detection.seoContext?.observedValue ?? '';
      return `${pfx}seo_title_duplicate_across_routes|${title}`;
    }
    case 'seo_meta_description_missing':
      return `${pfx}seo_meta_description_missing|${detection.pageRoute ?? ''}`;
    case 'seo_canonical_missing':
      return `${pfx}seo_canonical_missing|${detection.pageRoute ?? ''}`;
    case 'seo_h1_missing_or_multiple': {
      const h1Count = detection.seoContext?.observedValue ?? '';
      return `${pfx}seo_h1_missing_or_multiple|${detection.pageRoute ?? ''}|${h1Count}`;
    }
    case 'seo_robots_blocking_crawl':
      return `${pfx}seo_robots_blocking_crawl|${detection.pageRoute ?? ''}`;

    // v0.23 clock-injection kinds
    case 'clock_dst_corruption':
      return `${pfx}clock_dst_corruption|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.condition ?? ''}`;
    case 'clock_leap_day_failure':
      return `${pfx}clock_leap_day_failure|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.proof ?? ''}`;
    case 'clock_skew_token_invalid':
      return `${pfx}clock_skew_token_invalid|${detection.endpoint ?? ''}|${detection.clockContext?.condition ?? ''}`;
    case 'clock_timezone_display':
      return `${pfx}clock_timezone_display|${detection.pageRoute ?? ''}|${detection.clockContext?.injectedTimezone ?? ''}`;
    case 'clock_overflow':
      return `${pfx}clock_overflow|${detection.endpoint ?? detection.pageRoute ?? ''}|${detection.clockContext?.condition ?? ''}`;

    // v0.22 nav-state kinds (§4.2)

    // nav_state_corruption: pageRoute + transition.kind + mismatchKind + seed.action.kind
    case 'nav_state_corruption': {
      const transitionKind = detection.navStateContext?.transitionKind ?? '';
      const mismatchKind = detection.navStateContext?.mismatchKind ?? '';
      const seedKind = detection.navStateContext?.seedActionKind ?? '';
      return `${pfx}nav_state_corruption|${detection.pageRoute ?? ''}|${transitionKind}|${mismatchKind}|${seedKind}`;
    }

    // nav_resubmit_on_back: pageRoute + endpoint (method + normalized path)
    case 'nav_resubmit_on_back': {
      const endpoint = detection.navStateContext?.endpoint ?? detection.endpoint ?? '';
      return `${pfx}nav_resubmit_on_back|${detection.pageRoute ?? ''}|${endpoint}`;
    }

    // nav_refresh_double_mutation: pageRoute + endpoint (method + normalized path)
    case 'nav_refresh_double_mutation': {
      const endpoint = detection.navStateContext?.endpoint ?? detection.endpoint ?? '';
      return `${pfx}nav_refresh_double_mutation|${detection.pageRoute ?? ''}|${endpoint}`;
    }

    // nav_form_state_lost: pageRoute + formSignature
    case 'nav_form_state_lost': {
      const formSig = detection.navStateContext?.formSignature ?? '';
      return `${pfx}nav_form_state_lost|${detection.pageRoute ?? ''}|${formSig}`;
    }

    // nav_form_state_stale: pageRoute + formSignature + staleField
    case 'nav_form_state_stale': {
      const formSig = detection.navStateContext?.formSignature ?? '';
      const staleField = detection.navStateContext?.staleField ?? '';
      return `${pfx}nav_form_state_stale|${detection.pageRoute ?? ''}|${formSig}|${staleField}`;
    }

    // v0.36 browser-platform kinds

    case 'service_worker_stale':
      return `${pfx}service_worker_stale|${detection.pageRoute ?? ''}`;
    case 'web_worker_error': {
      const scriptUrl = detection.browserPlatformContext?.kind === 'worker'
        ? detection.browserPlatformContext.scriptUrl
        : '';
      return `${pfx}web_worker_error|${detection.pageRoute ?? ''}|${scriptUrl}`;
    }
    case 'iframe_postmessage_unguarded':
      return `${pfx}iframe_postmessage_unguarded|${detection.pageRoute ?? ''}`;
    case 'shadow_dom_a11y_violation': {
      const ctx = detection.browserPlatformContext;
      const host = ctx?.kind === 'shadow_a11y' ? hostTagNameOf(ctx.hostSelector) : '';
      const rule = ctx?.kind === 'shadow_a11y' ? ctx.axeRuleId : '';
      return `${pfx}shadow_dom_a11y_violation|${detection.pageRoute ?? ''}|${host}|${rule}`;
    }
    case 'permission_denied_unhandled': {
      const perm = detection.browserPlatformContext?.kind === 'permission'
        ? detection.browserPlatformContext.permission
        : '';
      return `${pfx}permission_denied_unhandled|${detection.pageRoute ?? ''}|${perm}`;
    }
    case 'webrtc_ice_failure':
      return `${pfx}webrtc_ice_failure|${detection.pageRoute ?? ''}`;
    case 'subresource_integrity_violation': {
      const blockedUrl = detection.browserPlatformContext?.kind === 'sri'
        ? detection.browserPlatformContext.blockedUrl
        : '';
      return `${pfx}subresource_integrity_violation|${detection.pageRoute ?? ''}|${blockedUrl}`;
    }
    case 'coop_coep_violation':
      return `${pfx}coop_coep_violation|${detection.pageRoute ?? ''}`;
    case 'trusted_types_violation': {
      const blockedURI = detection.browserPlatformContext?.kind === 'trusted_types'
        ? detection.browserPlatformContext.blockedURI
        : '';
      return `${pfx}trusted_types_violation|${detection.pageRoute ?? ''}|${blockedURI}`;
    }

    // v0.20 network-fault kinds: route + selectorClass + action + variant
    case 'network_fault_unhandled': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `${pfx}network_fault_unhandled|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }
    case 'network_fault_optimistic_no_revert': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `${pfx}network_fault_optimistic_no_revert|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }
    case 'infinite_loading': {
      const action = detection.triggeringAction?.kind ?? '';
      const variant = detection.networkFaultContext?.faultVariant ?? '';
      return `${pfx}infinite_loading|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${action}|${variant}`;
    }

    // v0.43 agentic-app detection kinds

    case 'agent_response_hallucinated': {
      const claimNorm = normalizeAgentClaim(detection.agentContext?.proof?.kind === 'unsupported_claim' ? detection.agentContext.proof.claim : '');
      return `${pfx}agent_response_hallucinated|${detection.endpoint ?? ''}|${claimNorm}`;
    }
    case 'agent_action_timeout':
      return `${pfx}agent_action_timeout|${detection.endpoint ?? ''}`;
    case 'prompt_injection_executed':
      return `${pfx}prompt_injection_executed|${detection.endpoint ?? ''}|${detection.injectionContext?.paramName ?? ''}|${detection.injectionContext?.variant ?? ''}`;
    case 'streaming_response_truncated': {
      const reason = detection.agentContext?.proof?.kind === 'truncated' ? detection.agentContext.proof.reason : 'unknown';
      return `${pfx}streaming_response_truncated|${detection.endpoint ?? ''}|${reason}`;
    }
    case 'tool_call_failure_unhandled': {
      const toolEndpoint = detection.agentContext?.proof?.kind === 'silent_failure' ? detection.agentContext.proof.toolEndpoint : '';
      return `${pfx}tool_call_failure_unhandled|${toolEndpoint}`;
    }
    case 'agent_cost_per_turn_high':
      return `${pfx}agent_cost_per_turn_high|${detection.endpoint ?? ''}|${detection.agentContext?.modelId ?? 'unknown'}`;
    // v37 i18n / locale stress kinds
    case 'i18n_rtl_layout_break':
    case 'i18n_long_string_overflow':
    case 'i18n_date_format_ambiguous':
    case 'i18n_pluralization_broken':
    case 'i18n_currency_format_broken':
    case 'i18n_timezone_display_wrong': {
      const sel = detection.selectorClass ?? '';
      return `${pfx}${detection.kind}|${detection.pageRoute ?? ''}|${sel}`;
    }

    case 'i18n_hardcoded_string': {
      const file = detection.staticContext?.sourceFile ?? '';
      const line = String(detection.staticContext?.sourceLine ?? '');
      return `${pfx}i18n_hardcoded_string|${file}|${line}`;
    }

    // v0.38 interaction-palette kinds
    case 'drag_drop_failure': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'drag_drop' ? ctx.proof : '';
      return `${pfx}drag_drop_failure|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'paste_handler_failure': {
      const ctx = detection.interactionContext;
      const pasteSource = ctx?.kind === 'paste' ? ctx.pasteSource : '';
      const proof = ctx?.kind === 'paste' ? ctx.proof : '';
      return `${pfx}paste_handler_failure|${detection.pageRoute ?? ''}|${pasteSource}|${proof}`;
    }
    case 'autofill_state_desync': {
      const ctx = detection.interactionContext;
      const field = ctx?.kind === 'autofill' ? ctx.autofillField : '';
      const proof = ctx?.kind === 'autofill' ? ctx.proof : '';
      return `${pfx}autofill_state_desync|${detection.pageRoute ?? ''}|${field}|${proof}`;
    }
    case 'animation_state_corruption': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'animation' ? ctx.proof : '';
      return `${pfx}animation_state_corruption|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'print_stylesheet_broken': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'env' ? ctx.proof : '';
      return `${pfx}print_stylesheet_broken|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'reduced_motion_violation': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'env' ? ctx.proof : '';
      return `${pfx}reduced_motion_violation|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'forced_colors_failure': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'env' ? ctx.proof : '';
      return `${pfx}forced_colors_failure|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'dark_mode_layout_break': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'env' ? ctx.proof : '';
      return `${pfx}dark_mode_layout_break|${detection.pageRoute ?? ''}|${proof}`;
    }
    case 'zoom_layout_break': {
      const ctx = detection.interactionContext;
      const proof = ctx?.kind === 'env' ? ctx.proof : '';
      return `${pfx}zoom_layout_break|${detection.pageRoute ?? ''}|${proof}`;
    }

    // v0.42 data-integrity invariant kinds
    case 'data_integrity_orphan':
    case 'money_math_precision':
    case 'cache_staleness':
    case 'idempotency_key_violation':
    case 'audit_log_missing_for_mutation':
    case 'soft_delete_consistency': {
      const invariantName = detection.dataIntegrityContext?.invariantName ?? '';
      return `${pfx}${detection.kind}|${invariantName}|${detection.endpoint ?? detection.pageRoute ?? ''}`;
    }
    // v0.41 mobile / responsive kinds
    case 'touch_target_too_small':
      return `${pfx}touch_target_too_small|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'hover_only_affordance':
      return `${pfx}hover_only_affordance|${detection.selectorClass ?? ''}`;
    case 'viewport_100vh_break':
      return `${pfx}viewport_100vh_break|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'soft_keyboard_occlusion':
      return `${pfx}soft_keyboard_occlusion|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'orientation_change_layout_break':
      return `${pfx}orientation_change_layout_break|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
    case 'pull_to_refresh_conflict':
      return `${pfx}pull_to_refresh_conflict|${detection.pageRoute ?? ''}`;
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
