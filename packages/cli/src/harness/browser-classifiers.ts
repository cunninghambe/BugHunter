// V56.4.2+ per-kind classifier registry. Each classifier converts a per-route
// HarvestEnvelope into a list of (route, rootCause, severity) tuples that the
// caller wraps into BugCluster[] via buildBrowserHarnessCluster().
//
// New browser-routed BugKinds register a classifier here when their
// V56.4.x PR lands.

import type { BugKind } from '../types.js';
import type { HarvestEnvelope } from './browser-executor.js';
import { isReactError, isHydrationError } from '../classify/react.js';
import { classifyNavTransition, classifyBackAfterFormFill } from '../classify/nav-state.js';
import { classifyA11yBaseline } from '../classify/a11y-baseline.js';
import { classifyMissingStateChange } from '../classify/state-change.js';
import { classifyIdorOutcome } from '../security/idor-classifier.js';
import {
  detectDoubleSubmit,
  detectClickThenNavigate,
  detectOptimisticRevert,
  detectInterleavedMutations,
  detectCrossTab,
} from '../security/race-detectors.js';
import { detectMultiContextStateDivergence } from '../security/multi-context-detectors.js';
import type {
  DoubleSubmitPlan,
  ClickThenNavigatePlan,
  OptimisticRevertPlan,
  InterleavedMutationsPlan,
  CrossTabPlan,
} from '../security/race-detectors.js';

export type BrowserHarnessHit = {
  route: string;
  rootCause: string;
  severity: 'critical' | 'major' | 'minor' | 'info';
};

export type BrowserHarnessClassifier = (envelope: HarvestEnvelope) => BrowserHarnessHit[];

const REGISTRY: Partial<Record<BugKind, BrowserHarnessClassifier>> = {
  // ---- Bucket A: console_error ----
  console_error(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    if (errors.length === 0) return [];
    const sample = errors[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `console.error called ${errors.length} time(s) on ${envelope.pageRoute} — first message: "${sample.slice(0, 120)}"`,
      severity: 'major',
    }];
  },

  // ---- Bucket A: unhandled_exception ----
  unhandled_exception(envelope) {
    const total = envelope.uncaughtErrors.length + envelope.unhandledRejections.length;
    if (total === 0) return [];
    const sample = envelope.uncaughtErrors[0]?.message
      ?? envelope.unhandledRejections[0]?.reason
      ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${total} uncaught exception(s)/rejection(s) on ${envelope.pageRoute} — first: "${sample.slice(0, 120)}"`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: react_error (production isReactError pattern) ----
  // hydration errors are a more-specific subkind — when isHydrationError matches,
  // we DON'T fire react_error (production behaviour: hydration takes precedence).
  react_error(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    const reactish = errors.filter(e => !isHydrationError(e.message) && isReactError(e.message));
    if (reactish.length === 0) return [];
    const sample = reactish[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${reactish.length} React-pattern console.error(s) on ${envelope.pageRoute} — "${sample.slice(0, 120)}"`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: hydration_mismatch ----
  hydration_mismatch(envelope) {
    const errors = envelope.consoleEvents.filter(e => e.level === 'error');
    const hits = errors.filter(e => isHydrationError(e.message));
    if (hits.length === 0) return [];
    const sample = hits[0]?.message ?? '';
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} hydration-mismatch console.error(s) on ${envelope.pageRoute} — "${sample.slice(0, 120)}"`,
      severity: 'major',
    }];
  },

  // ---- Bucket B: accessibility_critical ----
  // Production threshold: violation.impact === 'critical' || 'serious'.
  accessibility_critical(envelope) {
    const hits = envelope.axeViolations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (hits.length === 0) return [];
    const sample = hits[0];
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} critical/serious axe violation(s) on ${envelope.pageRoute} — first: ${sample?.id} (${sample?.impact})`,
      severity: 'critical',
    }];
  },

  // ---- Bucket B: axe_color_contrast_strong ----
  axe_color_contrast_strong(envelope) {
    const hits = envelope.axeViolations.filter(v => v.id === 'color-contrast');
    if (hits.length === 0) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Color contrast violation on ${envelope.pageRoute} — ${hits[0]?.nodes ?? 0} affected node(s) (WCAG AA 4.5:1 normal / 3:1 large)`,
      severity: 'critical',
    }];
  },

  // ---- Bucket A: dom_error_text ----
  // Production pattern: /(something went wrong|an error occurred|unable to|failed to)/i
  // applied to TreeWalker text nodes. Harness reads envelope.domState.bodyTextSample
  // (capped at 1000 chars) which is sufficient for short error messages typically
  // rendered by toast / error-boundary components.
  dom_error_text(envelope) {
    const text = envelope.domState.bodyTextSample;
    const re = /(something went wrong|an error occurred|unable to|failed to)/i;
    const match = re.exec(text);
    if (match === null) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Error text in DOM on ${envelope.pageRoute}: "${match[0]}" (sample: "${text.slice(0, 100)}")`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: slow_lcp ----
  slow_lcp(envelope) {
    const lcp = envelope.performanceEntries.filter(e => e.entryType === 'largest-contentful-paint');
    if (lcp.length === 0) return [];
    const worst = lcp.reduce((a, b) => ((a.value ?? 0) > (b.value ?? 0) ? a : b));
    const value = worst.value ?? 0;
    if (value <= 4000) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `LCP ${Math.round(value)}ms on ${envelope.pageRoute} (threshold: 4000ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: slow_inp ----
  // Calibration-shape: 'first-input' entry's `value` carries the input-delay/duration ms.
  slow_inp(envelope) {
    const fid = envelope.performanceEntries.filter(e => e.entryType === 'first-input');
    if (fid.length === 0) return [];
    const worst = fid.reduce((a, b) => ((a.value ?? a.duration ?? 0) > (b.value ?? b.duration ?? 0) ? a : b));
    const value = worst.value ?? worst.duration ?? 0;
    if (value <= 200) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `INP ${Math.round(value)}ms on ${envelope.pageRoute} (threshold: 200ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: high_cls ----
  // CLS is a session-cumulative value — sum the .value field across all layout-shift entries.
  high_cls(envelope) {
    const shifts = envelope.performanceEntries.filter(e => e.entryType === 'layout-shift');
    if (shifts.length === 0) return [];
    const cumulative = shifts.reduce((sum, s) => sum + (s.value ?? 0), 0);
    if (cumulative <= 0.25) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Cumulative Layout Shift ${cumulative.toFixed(3)} on ${envelope.pageRoute} (threshold: 0.25)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: main_thread_blocked ----
  // Fires on any longtask whose duration > 50ms (W3C Long Task minimum).
  main_thread_blocked(envelope) {
    const longTasks = envelope.performanceEntries.filter(e => e.entryType === 'longtask');
    if (longTasks.length === 0) return [];
    const worst = longTasks.reduce((a, b) => ((a.duration ?? 0) > (b.duration ?? 0) ? a : b));
    const duration = worst.duration ?? 0;
    if (duration <= 50) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: `Main thread blocked for ${Math.round(duration)}ms on ${envelope.pageRoute} (threshold: 50ms)`,
      severity: 'major',
    }];
  },

  // ---- Bucket C: n_plus_one_api_calls ----
  // Group by method + path with trailing /\\d+ segments collapsed to /:id.
  // Fire when any group has >= 5 same-shape calls.
  n_plus_one_api_calls(envelope) {
    if (envelope.resourceRequests.length === 0) return [];
    const groups = new Map<string, number>();
    for (const r of envelope.resourceRequests) {
      const method = r.method ?? 'GET';
      let path: string;
      try { path = new URL(r.url).pathname; }
      catch { path = r.url; }
      const family = path.replace(/\/\d+(?=\/|$)/g, '/:id');
      const key = `${method} ${family}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const hits: BrowserHarnessHit[] = [];
    for (const [key, count] of groups) {
      if (count >= 5) {
        hits.push({
          route: envelope.pageRoute,
          rootCause: `${key} called ${count} times on ${envelope.pageRoute} (N+1 threshold: 5)`,
          severity: 'minor',
        });
      }
    }
    return hits;
  },

  // ---- Bucket C: request_dedup_missing ----
  // Fire when >= 3 identical (method+url) calls are present.
  request_dedup_missing(envelope) {
    if (envelope.resourceRequests.length === 0) return [];
    const groups = new Map<string, number>();
    for (const r of envelope.resourceRequests) {
      const method = r.method ?? 'GET';
      const key = `${method} ${r.url}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    const hits: BrowserHarnessHit[] = [];
    for (const [key, count] of groups) {
      if (count >= 3) {
        hits.push({
          route: envelope.pageRoute,
          rootCause: `${key} issued ${count} identical times on ${envelope.pageRoute} — request not deduplicated`,
          severity: 'minor',
        });
      }
    }
    return hits;
  },

  // ---- Bucket C: request_cancellation_missing ----
  // Calibration-shape: resource entries with inflightOnNav: true marker.
  // Production: harness observes navigation events and correlates with
  // in-flight resources; the marker stands in for that observation here.
  request_cancellation_missing(envelope) {
    const hits = envelope.resourceRequests.filter(r => r.inflightOnNav === true);
    if (hits.length === 0) return [];
    const sample = hits[0];
    return [{
      route: envelope.pageRoute,
      rootCause: `${hits.length} request(s) in-flight at navigation on ${envelope.pageRoute} — first: ${sample?.method ?? 'GET'} ${sample?.url ?? ''} (cancellation missing)`,
      severity: 'minor',
    }];
  },

  // ---- Bucket D: nav-state ----
  // All five nav-state kinds dispatch through production classifyNavTransition()
  // / classifyBackAfterFormFill(). The fixture pushes pre/interim/post snapshots
  // via window.__bh.pushNavInput() and setBackAfterFormFill() — same data shape
  // the production nav-transition-runner produces, fed directly through the
  // classifier without driving real back/forward/refresh navigation.
  nav_state_corruption(envelope) { return dispatchNavTransitionFor('nav_state_corruption', envelope); },
  nav_resubmit_on_back(envelope) { return dispatchNavTransitionFor('nav_resubmit_on_back', envelope); },
  nav_refresh_double_mutation(envelope) { return dispatchNavTransitionFor('nav_refresh_double_mutation', envelope); },
  nav_form_state_lost(envelope) { return dispatchBackAfterFormFillFor('nav_form_state_lost', envelope); },
  nav_form_state_stale(envelope) { return dispatchBackAfterFormFillFor('nav_form_state_stale', envelope); },

  // ---- Bucket E: keyboard_trap (dispatches through classifyA11yBaseline) ----
  keyboard_trap(envelope) { return dispatchA11yBaselineFor('keyboard_trap', envelope); },

  // ---- Bucket E: focus_lost_after_action ----
  focus_lost_after_action(envelope) { return dispatchA11yBaselineFor('focus_lost_after_action', envelope); },

  // ---- Bucket E: shadow_dom_a11y_violation ----
  // Production: browser-platform-probe runs axe inside each open shadow root and
  // emits one detection per critical/serious violation. Calibration: fixture pushes
  // synthesized HarvestShadowAxeViolation records via window.__bh.pushShadowAxe.
  shadow_dom_a11y_violation(envelope) {
    if (envelope.shadowAxeViolations.length === 0) return [];
    const hits = envelope.shadowAxeViolations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (hits.length === 0) return [];
    return hits.map(v => ({
      route: envelope.pageRoute,
      rootCause: `Axe rule "${v.ruleId}" (${v.impact}) violated inside shadow root of <${v.hostTagName}>${v.description !== undefined ? ` — ${v.description}` : ''}`,
      severity: 'major' as const,
    }));
  },

  // ---- Bucket E: visibility_change_state_loss ----
  // Production: multi-context-detectors observe state across two contexts after a
  // lifecycle event and emit when state diverges or rolls back. Calibration: fixture
  // pushes a HarvestVisibilityChangeLoss payload mimicking the production shape.
  visibility_change_state_loss(envelope) {
    if (envelope.visibilityChangeStateLoss === null) return [];
    const v = envelope.visibilityChangeStateLoss;
    return [{
      route: envelope.pageRoute,
      rootCause: `${v.proof.replace(/_/g, ' ')} after ${v.lifecycleEvent} on ${v.toolPath} — ${v.evidence}`,
      severity: 'minor' as const,
    }];
  },

  // ---- Bucket B remainder: missing_state_change ----
  // Dispatches through production classifyMissingStateChange.
  missing_state_change(envelope) {
    if (envelope.missingStateChangeInput === null) return [];
    const { pre, post, action } = envelope.missingStateChangeInput;
    const detection = classifyMissingStateChange(pre, post, action, envelope.pageRoute);
    if (detection === null) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: detection.rootCause,
      severity: 'minor',
    }];
  },

  // ---- Bucket B remainder: surface_call_failed ----
  // Mirrors the inline rule in execute.ts: status 4xx + happy palette + not a
  // mutator-validation-rejection. Calibration fixture pushes synthesized
  // SurfaceCallResult shapes via window.__bh.pushSurfaceCallResult.
  surface_call_failed(envelope) {
    if (envelope.surfaceCallResults.length === 0) return [];
    const hits: BrowserHarnessHit[] = [];
    for (const r of envelope.surfaceCallResults) {
      if (r.ok === true) continue;
      if (r.palette !== 'happy') continue;
      const status = r.status ?? 0;
      if (status < 400 || status >= 500) continue;
      if (r.isValidationRejection === true) continue;
      const idLabel = r.toolId ?? r.toolName ?? '<unknown-tool>';
      const endpoint = r.endpoint ?? idLabel;
      hits.push({
        route: envelope.pageRoute,
        rootCause: `surface_call failed with status ${status} for tool ${idLabel} (endpoint: ${endpoint})${r.errorMessage !== undefined ? ` — ${r.errorMessage}` : ''}`,
        severity: 'major',
      });
    }
    return hits;
  },

  // ---- Bucket F: IDOR (4 kinds) ----
  // Modern V21 kinds (idor_horizontal_mutate, idor_vertical_suspicious) dispatch
  // through production classifyIdorOutcome.
  idor_horizontal_mutate(envelope) { return dispatchIdorModern('idor_horizontal_mutate', envelope, 'critical'); },
  idor_vertical_suspicious(envelope) { return dispatchIdorModern('idor_vertical_suspicious', envelope, 'major'); },

  // Legacy V05 idor_horizontal: peer-pair, status 200, body non-empty,
  // sideEffectClass safe (read-only). Calibration fixture sets shape='legacy_horizontal'.
  idor_horizontal(envelope) {
    const hits: BrowserHarnessHit[] = [];
    for (const r of envelope.idorReplays) {
      if (r.shape !== 'legacy_horizontal') continue;
      if (!isLegacyIdorReplayPositive(r)) continue;
      hits.push({
        route: envelope.pageRoute,
        rootCause: `Cross-user read: ${r.input.sourceRole} accessed ${r.input.targetRole}'s ${r.input.resourceType ?? 'resource'} (status ${r.input.status})`,
        severity: 'major',
      });
    }
    return hits;
  },

  // Legacy idor_vertical_role_escalate: status 200, body non-empty, accessor !== admin
  // (input.sourceRole != input.targetRole and accessor is non-admin tier).
  idor_vertical_role_escalate(envelope) {
    const hits: BrowserHarnessHit[] = [];
    for (const r of envelope.idorReplays) {
      if (r.shape !== 'legacy_vertical_role_escalate') continue;
      if (!isLegacyIdorReplayPositive(r)) continue;
      hits.push({
        route: envelope.pageRoute,
        rootCause: `Admin route ${r.toolId ?? '<unknown-tool>'} accessible as non-admin role '${r.accessorRole ?? r.input.sourceRole}'`,
        severity: 'critical',
      });
    }
    return hits;
  },

  // ---- Bucket F: race conditions (5 kinds) ----
  race_condition_double_submit(envelope) { return dispatchRaceFor('race_condition_double_submit', 'double_submit', envelope); },
  race_condition_click_navigate(envelope) { return dispatchRaceFor('race_condition_click_navigate', 'click_then_navigate', envelope); },
  race_condition_optimistic_revert(envelope) { return dispatchRaceFor('race_condition_optimistic_revert', 'optimistic_revert', envelope); },
  race_condition_interleaved_mutations(envelope) { return dispatchRaceFor('race_condition_interleaved_mutations', 'interleaved_mutations', envelope); },
  race_condition_cross_tab(envelope) { return dispatchRaceFor('race_condition_cross_tab', 'cross_tab', envelope); },

  // ---- Bucket F: multi_context_state_divergence ----
  multi_context_state_divergence(envelope) {
    if (envelope.multiContextDivergence === null) return [];
    const { plan, observationsByContext } = envelope.multiContextDivergence;
    const detection = detectMultiContextStateDivergence(plan, observationsByContext);
    if (detection === null) return [];
    return [{
      route: envelope.pageRoute,
      rootCause: detection.rootCause,
      severity: 'minor',
    }];
  },
};

function dispatchIdorModern(
  kind: BugKind,
  envelope: HarvestEnvelope,
  severity: 'critical' | 'major' | 'minor' | 'info',
): BrowserHarnessHit[] {
  const hits: BrowserHarnessHit[] = [];
  for (const r of envelope.idorReplays) {
    if (r.shape !== 'modern') continue;
    const outcome = classifyIdorOutcome(r.input);
    if (outcome === null || outcome.kind !== kind) continue;
    hits.push({
      route: envelope.pageRoute,
      rootCause: `IDOR ${outcome.tier}-tier replay: ${r.input.sourceRole} → ${r.input.targetRole}'s ${r.input.resourceType ?? 'resource'} succeeded (status ${r.input.status})${outcome.requiresAdjudication ? ' [requires adjudication]' : ''}`,
      severity,
    });
  }
  return hits;
}

// Legacy V05 IDOR rule: status 200, body non-empty, sideEffectClass !== external,
// sourceRole !== targetRole. Mirrors the implicit rule of the V05 inline emit
// (cross-user.ts pre-V21).
function isLegacyIdorReplayPositive(r: HarvestEnvelope['idorReplays'][number]): boolean {
  const i = r.input;
  if (i.sideEffectClass === 'external') return false;
  if (i.status < 200 || i.status >= 300) return false;
  if (i.status === 429) return false;
  if (i.body === null || i.body === undefined) return false;
  if (Array.isArray(i.body) && i.body.length === 0) return false;
  if (typeof i.body === 'object' && !Array.isArray(i.body)) {
    const rec = i.body as Record<string, unknown>;
    if ('data' in rec && Array.isArray(rec.data) && rec.data.length === 0) return false;
  }
  return true;
}

// Race detector dispatch. The fixture pushes (variantKind, plan, observations
// shape per variant). We run the matching detector and emit per `kind` if it
// returns non-null.
function dispatchRaceFor(
  kind: BugKind,
  variantKind: HarvestEnvelope['racePlans'][number]['variantKind'],
  envelope: HarvestEnvelope,
): BrowserHarnessHit[] {
  const hits: BrowserHarnessHit[] = [];
  for (const rp of envelope.racePlans) {
    if (rp.variantKind !== variantKind) continue;
    let detection: { kind: string; rootCause: string } | null = null;
    if (rp.variantKind === 'double_submit') detection = detectDoubleSubmit(rp.plan as DoubleSubmitPlan, rp.observations ?? []);
    else if (rp.variantKind === 'click_then_navigate') detection = detectClickThenNavigate(rp.plan as ClickThenNavigatePlan, rp.observations ?? []);
    else if (rp.variantKind === 'optimistic_revert') detection = detectOptimisticRevert(rp.plan as OptimisticRevertPlan, rp.observations ?? []);
    else if (rp.variantKind === 'interleaved_mutations') detection = detectInterleavedMutations(rp.plan as InterleavedMutationsPlan, rp.runObservations ?? []);
    else if (rp.variantKind === 'cross_tab') detection = detectCrossTab(rp.plan as CrossTabPlan, rp.tab1Obs ?? [], rp.tab2Obs ?? []);
    if (detection === null || detection.kind !== kind) continue;
    hits.push({
      route: envelope.pageRoute,
      rootCause: detection.rootCause,
      severity: 'major',
    });
  }
  return hits;
}

function dispatchA11yBaselineFor(kind: BugKind, envelope: HarvestEnvelope): BrowserHarnessHit[] {
  if (envelope.keyboardTrap === null && envelope.focusAfterAction === null) return [];
  const detections = classifyA11yBaseline({
    pageRoute: envelope.pageRoute,
    axeViolations: [],
    keyboardTrap: envelope.keyboardTrap ?? undefined,
    focusAfterAction: envelope.focusAfterAction ?? undefined,
  });
  const hits: BrowserHarnessHit[] = [];
  for (const d of detections) {
    if (d.kind !== kind) continue;
    hits.push({
      route: envelope.pageRoute,
      rootCause: d.rootCause,
      severity: kind === 'keyboard_trap' ? 'major' : 'minor',
    });
  }
  return hits;
}

// Run production classifyNavTransition over each pushed nav input and filter to
// detections matching `kind`. Returns one BrowserHarnessHit per qualifying
// detection.
function dispatchNavTransitionFor(kind: BugKind, envelope: HarvestEnvelope): BrowserHarnessHit[] {
  if (envelope.navInputs.length === 0) return [];
  const hits: BrowserHarnessHit[] = [];
  for (const input of envelope.navInputs) {
    const detections = classifyNavTransition(input);
    for (const d of detections) {
      if (d.kind !== kind) continue;
      hits.push({
        route: envelope.pageRoute,
        rootCause: d.rootCause,
        severity: 'major',
      });
    }
  }
  return hits;
}

function dispatchBackAfterFormFillFor(kind: BugKind, envelope: HarvestEnvelope): BrowserHarnessHit[] {
  if (envelope.backAfterFormFill === null) return [];
  const detections = classifyBackAfterFormFill(envelope.backAfterFormFill);
  const hits: BrowserHarnessHit[] = [];
  for (const d of detections) {
    if (d.kind !== kind) continue;
    hits.push({
      route: envelope.pageRoute,
      rootCause: d.rootCause,
      severity: 'minor',
    });
  }
  return hits;
}

export function getBrowserHarnessClassifier(kind: BugKind): BrowserHarnessClassifier | undefined {
  return REGISTRY[kind];
}
