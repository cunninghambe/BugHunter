// V56.4: Browser-driven harness — sibling to V56.3's static-fixture runHarness.
//
// Wraps an injected BrowserMcpAdapter (camofox in production, mock in tests).
// For each fixture route: open a tab, install bootstrap observer, settle, harvest
// the observation envelope, then call into the production classifier for the
// detector's kind. Cluster shape comes back identical to runHarness.
//
// Ships dormant in V56.4.1 — V56.4.2+ adds per-detector contracts that
// include `'browser-mcp'` in tools and rely on this runner.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectorContract, RequiredPhase } from '../detectors/contracts.js';
import type { BugCluster, BugKind, Occurrence } from '../types.js';
import type { BrowserMcpAdapter, EvaluateResult } from '../adapters/browser-mcp.js';
import type { NavClassifyInput, BackAfterFormFillInput } from '../classify/nav-state.js';
import type { KeyboardTrapResult, FocusAfterActionResult } from '../classify/a11y-baseline.js';
import type { PreState, PostState, Action, RaceObservation } from '../types.js';
import type { IdorClassifyInput } from '../security/idor-classifier.js';
import type {
  DoubleSubmitPlan,
  ClickThenNavigatePlan,
  OptimisticRevertPlan,
  InterleavedMutationsPlan,
  CrossTabPlan,
} from '../security/race-detectors.js';
import type { StateDivergencePlan } from '../security/multi-context-detectors.js';
import type { NetworkFaultSpec } from '../types.js';
import type { OptimisticSnapshot } from '../classify/network-fault-optimistic-revert.js';
import type { PromptProbe, AgentResponse } from '../security/pen-detectors.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BrowserHarnessTarget = {
  /** HTTP origin where the fixture's mini-server is listening (e.g. http://127.0.0.1:9763). */
  appBaseUrl: string;
  /** Absolute path to the fixture root. Used to load expected-clusters.jsonl for route enumeration. */
  fixturePath: string;
};

export type BrowserHarnessOptions = {
  contract: DetectorContract;
  target: BrowserHarnessTarget;
  /** Injected to make the runner mock-friendly in unit tests. */
  browser: BrowserMcpAdapter;
  budgetMs: number;
  signal?: AbortSignal;
  /** Override for tests; production reads observationWindowMs from contract.requires. */
  observationWindowMsOverride?: number;
};

export type BrowserHarnessResult = {
  clusters: BugCluster[];
  phasesRun: RequiredPhase[];
  envelopesByRoute: Map<string, HarvestEnvelope>;
  durationMs: number;
  budgetExceeded: boolean;
  warnings: string[];
  /** When set, the runner could not produce real observations and the caller should treat
   *  the result as a skipped run with this reason. */
  skipReason?: BrowserHarnessSkipReason;
};

export type BrowserHarnessSkipReason =
  | 'browser_mcp_unavailable'
  | 'camofox_tab_failure'
  | 'observation_window_exceeded';

/**
 * The single observation envelope harvested from a fixture page after the bootstrap
 * script has had time to subscribe to console / error / performance / DOM channels.
 *
 * Production classifiers consume well-typed slices of this envelope (consoleEvents
 * for console_error, performanceEntries for slow_lcp, etc.). The harness does not
 * itself implement detection — it only collects.
 */
export type HarvestEnvelope = {
  pageRoute: string;
  consoleEvents: HarvestConsoleEvent[];
  uncaughtErrors: HarvestUncaughtError[];
  unhandledRejections: HarvestUnhandledRejection[];
  performanceEntries: HarvestPerformanceEntry[];
  resourceRequests: HarvestResourceRequest[];
  domState: HarvestDomState;
  /** Populated only when contract.requires.observationWindowMs allows enough time
   *  for axe-core to inject + run; an empty array means axe was not invoked. */
  axeViolations: HarvestAxeViolation[];
  /** V56.4.9: nav-state inputs pushed by calibration fixtures via window.__bh.pushNavInput.
   *  Browser-classifiers dispatch each entry through the production classifyNavTransition. */
  navInputs: NavClassifyInput[];
  /** V56.4.9: optional back-after-form-fill input; production classifyBackAfterFormFill consumes it. */
  backAfterFormFill: BackAfterFormFillInput | null;
  /** V56.4.10 (Bucket E): keyboard-trap probe result. Production a11y-baseline
   *  produces this via Tab-press loop in the executor; calibration fixtures push
   *  it directly through the bootstrap. */
  keyboardTrap: KeyboardTrapResult | null;
  /** V56.4.10: focus-after-action probe result. */
  focusAfterAction: FocusAfterActionResult | null;
  /** V56.4.10: axe violations observed inside open shadow roots, with hostSelector
   *  + axe rule id + impact. Production runs axe.run() inside each shadow tree; the
   *  calibration fixture pushes synthesised entries via window.__bh.pushShadowAxe. */
  shadowAxeViolations: HarvestShadowAxeViolation[];
  /** V56.4.10: visibility-change-state-loss synthesised snapshot. Production needs
   *  a multi-context coordinated probe (see SPEC_V40_MULTI_CONTEXT.md); calibration
   *  pushes the resulting MultiContextDetectionContext-shaped payload directly. */
  visibilityChangeStateLoss: HarvestVisibilityChangeLoss | null;
  /** V56.4.11: missing-state-change input (PreState + PostState + Action) for
   *  classifyMissingStateChange dispatch. Calibration fixtures push this via
   *  window.__bh.setMissingStateChangeInput. Production captures it via
   *  pre/post execute-phase snapshots. */
  missingStateChangeInput: HarvestMissingStateChangeInput | null;
  /** V56.4.11: surface_call_failed input list. Production emits one detection per
   *  failed surface call; calibration pushes synthesized SurfaceCallResult shapes
   *  via window.__bh.pushSurfaceCallResult. */
  surfaceCallResults: HarvestSurfaceCallResult[];
  /** V56.4.13 (Bucket F): IDOR replay inputs. Each maps to one of 4 IDOR kinds
   *  via the discriminator `kindHint` plus classifyIdorOutcome dispatch (modern)
   *  or inline rule (legacy idor_horizontal / idor_vertical_role_escalate). */
  idorReplays: HarvestIdorReplay[];
  /** V56.4.13: race-condition (plan + observations) inputs. Each entry's
   *  variantKind selects which production race detector to dispatch through. */
  racePlans: HarvestRacePlan[];
  /** V56.4.13: multi_context_state_divergence input. */
  multiContextDivergence: HarvestMultiContextDivergence | null;
  /** V56.4.14: network_fault_unhandled input — fed to detectNetworkFaultUnhandled. */
  networkFaultUnhandledInput: HarvestNetworkFaultUnhandledInput | null;
  /** V56.4.14: network_fault_optimistic_no_revert input. */
  optimisticNoRevertInput: HarvestOptimisticNoRevertInput | null;
  /** V56.4.14: synthesized service_worker_stale / web_worker_error / webrtc_ice_failure findings. */
  browserPlatformDetections: HarvestBrowserPlatformDetection[];
  /** V56.4.14: visual_anomaly objects from a vision pass. */
  visualAnomalies: HarvestVisualAnomaly[];
  /** V56.4.14: prompt_injection_executed probes — dispatch through detectPromptInjection. */
  promptInjectionProbes: HarvestPromptInjectionProbe[];
  /** V56.4.14: i18n_rtl_layout_break geometric findings (each high-certainty entry fires one detection). */
  rtlGeoFindings: HarvestRtlGeoFinding[];
  /** V56.4.15: generic sentinel events for deferred kinds that use a sentinel-based
   *  "fixture pushes, classifier fires" pattern. Each entry has a `kind` discriminator
   *  and an opaque payload. */
  sentinelEvents: HarvestSentinelEvent[];
  /** Browser-side errors generated by the harness itself (bootstrap install failed,
   *  harvest readout returned null, etc.). Surfaced through warnings, never thrown. */
  harvestWarnings: string[];
};

export type HarvestShadowAxeViolation = {
  hostSelector: string;
  hostTagName: string;
  ruleId: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description?: string;
};

export type HarvestVisibilityChangeLoss = {
  /** lifecycle event sentinel ('visibilitychange' / 'pagehide' / etc.). */
  lifecycleEvent: string;
  /** "state_lost_post_lifecycle" / "silent_failure_post_lifecycle" / "rollback_post_lifecycle". */
  proof: string;
  /** path of the surface tool that lost state (production: plan.toolPath). */
  toolPath: string;
  /** evidence string. */
  evidence: string;
};

export type HarvestMissingStateChangeInput = {
  pre: PreState;
  post: PostState;
  action: Action;
};

/** Slim shape needed by the surface_call_failed harness classifier. Production
 *  inspects more fields (toolMap lookup, validation-rejection check) — calibration
 *  sets `valid: false` to mean "treat as not a validation-rejection". */
export type HarvestSurfaceCallResult = {
  ok: boolean;
  status?: number;
  palette: 'happy' | 'edge';
  toolId?: string;
  toolName?: string;
  endpoint?: string;
  errorMessage?: string;
  /** When true, the classifier treats this as a mutator-validation-rejection and skips. */
  isValidationRejection?: boolean;
};

/** V56.4.13: IDOR replay shape covering all 4 wired IDOR kinds.
 *  - 'modern' inputs dispatch through classifyIdorOutcome (idor_horizontal_mutate, idor_vertical_suspicious)
 *  - 'legacy' inputs dispatch through inline V05 rule (idor_horizontal, idor_vertical_role_escalate) */
export type HarvestIdorReplay = {
  /** Production classifier dispatch hint. */
  shape: 'modern' | 'legacy_horizontal' | 'legacy_vertical_role_escalate';
  /** Modern shape uses sourceRole/targetRole/sideEffectClass per IdorClassifyInput. */
  input: IdorClassifyInput;
  /** Legacy convenience: when shape !== 'modern', this carries the route/tool id and accessor role. */
  toolId?: string;
  accessorRole?: string;
};

/** V56.4.13: race-plan input. variantKind discriminates which production detector to dispatch through.
 *  - double_submit / click_then_navigate / optimistic_revert: observations is RaceObservation[]
 *  - interleaved_mutations: observations is RaceObservation[][] (one per consensus run)
 *  - cross_tab: observations is [tab1Obs, tab2Obs] (two arrays in order) */
export type HarvestRacePlan = {
  variantKind:
    | 'double_submit'
    | 'click_then_navigate'
    | 'optimistic_revert'
    | 'interleaved_mutations'
    | 'cross_tab';
  plan:
    | DoubleSubmitPlan
    | ClickThenNavigatePlan
    | OptimisticRevertPlan
    | InterleavedMutationsPlan
    | CrossTabPlan;
  /** Single-observation-array shape for double_submit / click_then_navigate / optimistic_revert. */
  observations?: RaceObservation[];
  /** Run-array shape for interleaved_mutations. */
  runObservations?: RaceObservation[][];
  /** Two-tab shape for cross_tab. */
  tab1Obs?: RaceObservation[];
  tab2Obs?: RaceObservation[];
};

/** V56.4.13: multi_context_state_divergence input. */
export type HarvestMultiContextDivergence = {
  plan: StateDivergencePlan;
  observationsByContext: RaceObservation[][];
};

// V56.4.14 (Bucket G) input shapes -------------------------------------------

export type HarvestNetworkFaultUnhandledInput = {
  preState: PreState;
  postState: PostState;
  fault: NetworkFaultSpec;
  retryStormThresholdRps: number;
  asyncMaxWaitMs: number;
};

export type HarvestOptimisticNoRevertInput = {
  preState: PreState;
  postState: PostState;
  fault: NetworkFaultSpec;
  optimisticSnapshot: OptimisticSnapshot | null;
  retryStormThresholdRps: number;
};

/** Discriminated union covering service_worker_stale / web_worker_error / webrtc_ice_failure. */
export type HarvestBrowserPlatformDetection =
  | { kind: 'service_worker_stale'; scope: string; ageMs: number; hasInstalling: boolean; hasWaiting: boolean; isFirstVisit?: boolean; controllerChangedDuringWindow?: boolean; thresholdMs: number }
  | { kind: 'web_worker_error'; scriptUrl: string; eventKind: string; errorMsg: string }
  | { kind: 'webrtc_ice_failure'; connectionId: string; finalState: string; hadHandler: boolean };

export type HarvestVisualAnomaly = {
  description: string;
  severity: 'minor' | 'major' | 'critical';
  category?: string;
  element?: string;
  suggestedFix?: string;
};

export type HarvestPromptInjectionProbe = {
  probe: PromptProbe;
  response: AgentResponse;
};

export type HarvestRtlGeoFinding = {
  /** geo-finding kind (e.g. 'overlap', 'overflow', 'cut_off'). */
  kind: string;
  certainty: 'low' | 'medium' | 'high';
  selector: string;
  pairSelector?: string;
};

/** V56.4.15: Generic sentinel event for deferred-kind harness wiring.
 *  Fixture pages push one of these via window.__bh.pushSentinelEvent({ kind, payload }).
 *  The browser classifier for each BugKind filters by `kind` and derives rootCause from `payload`. */
export type HarvestSentinelEvent = {
  /** BugKind discriminator. Must exactly match the BugKind string. */
  kind: string;
  /** Severity the classifier should emit for this event. */
  severity: 'critical' | 'major' | 'minor' | 'info';
  /** Human-readable root cause string. The classifier emits this directly. */
  rootCause: string;
};

export type HarvestConsoleEvent = {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  /** Source URL + position when the console event came from a stack-bearing call. */
  source?: { url?: string; lineno?: number; colno?: number };
};

export type HarvestUncaughtError = {
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
};

export type HarvestUnhandledRejection = {
  reason: string;
  stack?: string;
};

export type HarvestPerformanceEntry = {
  entryType: string;
  name: string;
  startTime: number;
  duration?: number;
  /** For LCP / CLS / FID, the metric value lives on the entry directly. We capture
   *  the raw shape so production classifiers can pluck the field they expect. */
  value?: number;
};

export type HarvestResourceRequest = {
  url: string;
  method?: string;
  status?: number;
  durationMs?: number;
  initiatorType?: string;
  /** Optional fields used by calibration fixtures and (in production) by
   *  the request-hygiene observer. `startTime` is high-res ms; `inflightOnNav`
   *  marks a request that was still in-flight when the next navigation began. */
  startTime?: number;
  duration?: number;
  inflightOnNav?: boolean;
};

export type HarvestDomState = {
  activeElementTag: string | null;
  bodyTextLength: number;
  bodyTextSample: string;
};

export type HarvestAxeViolation = {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  nodes: number;
  description: string;
};

// ---------------------------------------------------------------------------
// Bootstrap + harvest scripts
// ---------------------------------------------------------------------------

/**
 * Installed via `evaluate(BOOTSTRAP_INSTALL_SCRIPT)` after navigate completes.
 * Subscribes to all observation channels and writes results to window.__bh.
 *
 * The script must be self-contained (no closures over outer vars) and idempotent:
 * if `window.__bh` is already populated, do nothing.
 */
export const BOOTSTRAP_INSTALL_SCRIPT = `(() => {
  if (window.__bh && window.__bh.installed) return { ok: true, alreadyPresent: true };
  const bh = {
    installed: true,
    consoleEvents: [],
    uncaughtErrors: [],
    unhandledRejections: [],
    performanceEntries: [],
    resourceRequests: [],
    harvestWarnings: [],
  };
  window.__bh = bh;

  // Console capture (level → array push)
  ['log', 'info', 'warn', 'error'].forEach(level => {
    const orig = console[level];
    console[level] = function() {
      try {
        const args = Array.prototype.slice.call(arguments);
        const message = args.map(a => {
          if (a === null || a === undefined) return String(a);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_e) { return String(a); }
        }).join(' ');
        bh.consoleEvents.push({ level: level, message: message.slice(0, 2000) });
      } catch (_e) {
        bh.harvestWarnings.push('console_capture_threw:' + String(_e));
      }
      return orig.apply(console, arguments);
    };
  });

  // Uncaught error capture
  window.addEventListener('error', (ev) => {
    try {
      bh.uncaughtErrors.push({
        message: String(ev.message || '').slice(0, 1000),
        filename: ev.filename,
        lineno: ev.lineno,
        colno: ev.colno,
        stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4000) : undefined,
      });
    } catch (_e) {
      bh.harvestWarnings.push('error_capture_threw:' + String(_e));
    }
  });

  // Unhandled rejection capture
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const reason = ev.reason;
      const reasonStr = reason instanceof Error ? reason.message : (typeof reason === 'string' ? reason : JSON.stringify(reason));
      bh.unhandledRejections.push({
        reason: String(reasonStr || 'unknown').slice(0, 1000),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 4000) : undefined,
      });
    } catch (_e) {
      bh.harvestWarnings.push('rejection_capture_threw:' + String(_e));
    }
  });

  // PerformanceObserver — LCP, FID, CLS, longtask, resource
  try {
    const types = ['largest-contentful-paint', 'first-input', 'layout-shift', 'longtask', 'resource'];
    types.forEach(t => {
      try {
        const po = new PerformanceObserver((list) => {
          list.getEntries().forEach(e => {
            const base = {
              entryType: e.entryType,
              name: e.name || '',
              startTime: e.startTime,
              duration: e.duration,
            };
            if (e.entryType === 'largest-contentful-paint') {
              base.value = e.renderTime || e.loadTime || e.startTime;
            }
            if (e.entryType === 'first-input') {
              base.value = e.processingStart - e.startTime;
            }
            if (e.entryType === 'layout-shift') {
              base.value = e.value;
            }
            bh.performanceEntries.push(base);
            if (e.entryType === 'resource') {
              bh.resourceRequests.push({
                url: e.name,
                duration: e.duration,
                initiatorType: e.initiatorType,
              });
            }
          });
        });
        po.observe({ type: t, buffered: true });
      } catch (_e) {
        bh.harvestWarnings.push('po_subscribe_failed:' + t + ':' + String(_e));
      }
    });
  } catch (_e) {
    bh.harvestWarnings.push('po_init_failed:' + String(_e));
  }

  return { ok: true, installed: true };
})()`;

/**
 * Read the harvest envelope from the DOM-bridged `<script id="__bh-data">`
 * element. The bootstrap (running in the page's main world) mirrors
 * `window.__bh` state into this element's textContent on every event push.
 * Reading via document is world-agnostic — works whether camofox's evaluate
 * runs in main or isolated world. Falls back to `window.__bh` direct read
 * when the bootstrap is in same world as the harvest.
 */
export const HARVEST_SCRIPT = `(() => {
  const empty = {
    consoleEvents: [],
    uncaughtErrors: [],
    unhandledRejections: [],
    performanceEntries: [],
    resourceRequests: [],
    domState: { activeElementTag: null, bodyTextLength: 0, bodyTextSample: '' },
    harvestWarnings: ['bootstrap_not_installed'],
  };
  const activeEl = document.activeElement;
  const bodyText = (document.body && document.body.innerText) || '';
  const domState = {
    activeElementTag: activeEl ? activeEl.tagName : null,
    bodyTextLength: bodyText.length,
    bodyTextSample: bodyText.slice(0, 1000),
  };
  // Prefer DOM-bridged state — works across world boundaries.
  const dataEl = document.getElementById('__bh-data');
  if (dataEl && dataEl.textContent) {
    try {
      const parsed = JSON.parse(dataEl.textContent);
      if (parsed && parsed.installed === true) {
        return {
          consoleEvents: Array.isArray(parsed.consoleEvents) ? parsed.consoleEvents : [],
          uncaughtErrors: Array.isArray(parsed.uncaughtErrors) ? parsed.uncaughtErrors : [],
          unhandledRejections: Array.isArray(parsed.unhandledRejections) ? parsed.unhandledRejections : [],
          performanceEntries: Array.isArray(parsed.performanceEntries) ? parsed.performanceEntries : [],
          resourceRequests: Array.isArray(parsed.resourceRequests) ? parsed.resourceRequests : [],
          axeViolations: Array.isArray(parsed.axeViolations) ? parsed.axeViolations : [],
          navInputs: Array.isArray(parsed.navInputs) ? parsed.navInputs : [],
          backAfterFormFill: parsed.backAfterFormFill || null,
          keyboardTrap: parsed.keyboardTrap || null,
          focusAfterAction: parsed.focusAfterAction || null,
          shadowAxeViolations: Array.isArray(parsed.shadowAxeViolations) ? parsed.shadowAxeViolations : [],
          visibilityChangeStateLoss: parsed.visibilityChangeStateLoss || null,
          missingStateChangeInput: parsed.missingStateChangeInput || null,
          surfaceCallResults: Array.isArray(parsed.surfaceCallResults) ? parsed.surfaceCallResults : [],
          idorReplays: Array.isArray(parsed.idorReplays) ? parsed.idorReplays : [],
          racePlans: Array.isArray(parsed.racePlans) ? parsed.racePlans : [],
          multiContextDivergence: parsed.multiContextDivergence || null,
          networkFaultUnhandledInput: parsed.networkFaultUnhandledInput || null,
          optimisticNoRevertInput: parsed.optimisticNoRevertInput || null,
          browserPlatformDetections: Array.isArray(parsed.browserPlatformDetections) ? parsed.browserPlatformDetections : [],
          visualAnomalies: Array.isArray(parsed.visualAnomalies) ? parsed.visualAnomalies : [],
          promptInjectionProbes: Array.isArray(parsed.promptInjectionProbes) ? parsed.promptInjectionProbes : [],
          rtlGeoFindings: Array.isArray(parsed.rtlGeoFindings) ? parsed.rtlGeoFindings : [],
          sentinelEvents: Array.isArray(parsed.sentinelEvents) ? parsed.sentinelEvents : [],
          domState: domState,
          harvestWarnings: Array.isArray(parsed.harvestWarnings) ? parsed.harvestWarnings : [],
        };
      }
    } catch (_e) { /* fall through */ }
  }
  // Fall back to direct window.__bh read (same-world install + harvest).
  const bh = window.__bh;
  if (!bh || !bh.installed) return Object.assign({}, empty, { domState: domState });
  return {
    consoleEvents: bh.consoleEvents.slice(0, 200),
    uncaughtErrors: bh.uncaughtErrors.slice(0, 50),
    unhandledRejections: bh.unhandledRejections.slice(0, 50),
    performanceEntries: bh.performanceEntries.slice(0, 200),
    resourceRequests: bh.resourceRequests.slice(0, 200),
    domState: domState,
    harvestWarnings: bh.harvestWarnings.slice(0, 50),
  };
})()`;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DEFAULT_OBSERVATION_WINDOW_MS = 1500;

function computeObservationWindowMs(contract: DetectorContract, override?: number): number {
  if (typeof override === 'number') return override;
  const declared = contract.requires.observationWindowMs;
  const fallback = typeof declared === 'number' ? declared : DEFAULT_OBSERVATION_WINDOW_MS;
  // Cap at defaultBudgetMs / 4 to leave room for navigate + harvest + classify.
  const cap = Math.floor(contract.defaultBudgetMs / 4);
  return Math.min(fallback, cap);
}

function loadProbeRoutes(fixturePath: string, filterKind?: string): string[] {
  const jsonlPath = path.join(fixturePath, 'expected-clusters.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];
  const pages = new Set<string>();
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { expect?: string; kind?: string; match?: { page?: string } };
      // V56.4.x: only probe routes that have an assertion for the kind being tested.
      // Multi-kind fixtures (e.g. mixed-runtime-mini) declare 20+ routes; without
      // filtering, a single test-detector run would probe all of them and exceed
      // the 30s budget.
      if (filterKind !== undefined && parsed.kind !== filterKind) continue;
      if ((parsed.expect === 'fires' || parsed.expect === 'silent') && parsed.match?.page !== undefined) {
        pages.add(parsed.match.page);
      }
    } catch {
      // skip malformed
    }
  }
  return [...pages];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

function emptyEnvelope(route: string, harvestWarnings: string[] = []): HarvestEnvelope {
  return {
    pageRoute: route,
    consoleEvents: [],
    uncaughtErrors: [],
    unhandledRejections: [],
    performanceEntries: [],
    resourceRequests: [],
    domState: { activeElementTag: null, bodyTextLength: 0, bodyTextSample: '' },
    axeViolations: [],
    navInputs: [],
    backAfterFormFill: null,
    keyboardTrap: null,
    focusAfterAction: null,
    shadowAxeViolations: [],
    visibilityChangeStateLoss: null,
    missingStateChangeInput: null,
    surfaceCallResults: [],
    idorReplays: [],
    racePlans: [],
    multiContextDivergence: null,
    networkFaultUnhandledInput: null,
    optimisticNoRevertInput: null,
    browserPlatformDetections: [],
    visualAnomalies: [],
    promptInjectionProbes: [],
    rtlGeoFindings: [],
    sentinelEvents: [],
    harvestWarnings,
  };
}

/**
 * Coerce the raw EvaluateResult.value into a HarvestEnvelope. The bootstrap +
 * harvest scripts together produce a stable shape; we still defensively narrow
 * each field so a transport hiccup never crashes the runner.
 */
function parseHarvest(value: unknown, route: string): HarvestEnvelope {
  if (value === null || typeof value !== 'object') return emptyEnvelope(route, ['harvest_returned_non_object']);
  const obj = value as Record<string, unknown>;
  const pickArray = <T>(key: string): T[] => {
    const v = obj[key];
    return Array.isArray(v) ? (v as T[]) : [];
  };
  const dom = obj['domState'];
  const domState: HarvestDomState = (dom !== null && typeof dom === 'object')
    ? {
        activeElementTag: typeof (dom as Record<string, unknown>)['activeElementTag'] === 'string'
          ? ((dom as Record<string, unknown>)['activeElementTag'] as string)
          : null,
        bodyTextLength: typeof (dom as Record<string, unknown>)['bodyTextLength'] === 'number'
          ? ((dom as Record<string, unknown>)['bodyTextLength'] as number)
          : 0,
        bodyTextSample: typeof (dom as Record<string, unknown>)['bodyTextSample'] === 'string'
          ? ((dom as Record<string, unknown>)['bodyTextSample'] as string)
          : '',
      }
    : { activeElementTag: null, bodyTextLength: 0, bodyTextSample: '' };

  const backAfterFormFill = obj['backAfterFormFill'];
  const keyboardTrap = obj['keyboardTrap'];
  const focusAfterAction = obj['focusAfterAction'];
  const visibilityChangeStateLoss = obj['visibilityChangeStateLoss'];
  const missingStateChangeInput = obj['missingStateChangeInput'];
  const multiContextDivergence = obj['multiContextDivergence'];
  const networkFaultUnhandledInput = obj['networkFaultUnhandledInput'];
  const optimisticNoRevertInput = obj['optimisticNoRevertInput'];
  return {
    pageRoute: route,
    consoleEvents: pickArray<HarvestConsoleEvent>('consoleEvents'),
    uncaughtErrors: pickArray<HarvestUncaughtError>('uncaughtErrors'),
    unhandledRejections: pickArray<HarvestUnhandledRejection>('unhandledRejections'),
    performanceEntries: pickArray<HarvestPerformanceEntry>('performanceEntries'),
    resourceRequests: pickArray<HarvestResourceRequest>('resourceRequests'),
    domState,
    axeViolations: pickArray<HarvestAxeViolation>('axeViolations'),
    navInputs: pickArray<NavClassifyInput>('navInputs'),
    backAfterFormFill: (backAfterFormFill !== null && typeof backAfterFormFill === 'object')
      ? backAfterFormFill as BackAfterFormFillInput
      : null,
    keyboardTrap: (keyboardTrap !== null && typeof keyboardTrap === 'object')
      ? keyboardTrap as KeyboardTrapResult
      : null,
    focusAfterAction: (focusAfterAction !== null && typeof focusAfterAction === 'object')
      ? focusAfterAction as FocusAfterActionResult
      : null,
    shadowAxeViolations: pickArray<HarvestShadowAxeViolation>('shadowAxeViolations'),
    visibilityChangeStateLoss: (visibilityChangeStateLoss !== null && typeof visibilityChangeStateLoss === 'object')
      ? visibilityChangeStateLoss as HarvestVisibilityChangeLoss
      : null,
    missingStateChangeInput: (missingStateChangeInput !== null && typeof missingStateChangeInput === 'object')
      ? missingStateChangeInput as HarvestMissingStateChangeInput
      : null,
    surfaceCallResults: pickArray<HarvestSurfaceCallResult>('surfaceCallResults'),
    idorReplays: pickArray<HarvestIdorReplay>('idorReplays'),
    racePlans: pickArray<HarvestRacePlan>('racePlans'),
    multiContextDivergence: (multiContextDivergence !== null && typeof multiContextDivergence === 'object')
      ? multiContextDivergence as HarvestMultiContextDivergence
      : null,
    networkFaultUnhandledInput: (networkFaultUnhandledInput !== null && typeof networkFaultUnhandledInput === 'object')
      ? networkFaultUnhandledInput as HarvestNetworkFaultUnhandledInput
      : null,
    optimisticNoRevertInput: (optimisticNoRevertInput !== null && typeof optimisticNoRevertInput === 'object')
      ? optimisticNoRevertInput as HarvestOptimisticNoRevertInput
      : null,
    browserPlatformDetections: pickArray<HarvestBrowserPlatformDetection>('browserPlatformDetections'),
    visualAnomalies: pickArray<HarvestVisualAnomaly>('visualAnomalies'),
    promptInjectionProbes: pickArray<HarvestPromptInjectionProbe>('promptInjectionProbes'),
    rtlGeoFindings: pickArray<HarvestRtlGeoFinding>('rtlGeoFindings'),
    sentinelEvents: pickArray<HarvestSentinelEvent>('sentinelEvents'),
    harvestWarnings: pickArray<string>('harvestWarnings'),
  };
}

/**
 * Probe one route through the browser: navigate (via withTab), install bootstrap,
 * settle, harvest. Returns the envelope, or an error reason string on failure.
 */
async function probeRoute(
  browser: BrowserMcpAdapter,
  fullUrl: string,
  route: string,
  observationWindowMs: number,
  signal: AbortSignal | undefined,
  warnings: string[],
  preNavigateInstalled: boolean,
): Promise<{ ok: true; envelope: HarvestEnvelope } | { ok: false; reason: BrowserHarnessSkipReason }> {
  try {
    return await browser.withTab(fullUrl, undefined, async (scope) => {
      // If addInitScript wasn't applicable, install at evaluate time. This means
      // load-time events from inline page scripts may have already fired and been
      // missed — surfaced as a warning earlier; capture is best-effort.
      if (!preNavigateInstalled) {
        const installResult: EvaluateResult | null = await scope.evaluate(BOOTSTRAP_INSTALL_SCRIPT).catch((err) => {
          warnings.push(`browser-harness: install evaluate threw on ${route}: ${String(err)}`);
          return null;
        });
        if (installResult === null) {
          return { ok: false as const, reason: 'camofox_tab_failure' as const };
        }
      }

      try {
        await sleep(observationWindowMs, signal);
      } catch {
        return { ok: false as const, reason: 'observation_window_exceeded' as const };
      }

      const harvestResult: EvaluateResult | null = await scope.evaluate(HARVEST_SCRIPT).catch((err) => {
        warnings.push(`browser-harness: harvest evaluate threw on ${route}: ${String(err)}`);
        return null;
      });
      if (harvestResult === null) {
        return { ok: false as const, reason: 'camofox_tab_failure' as const };
      }

      const envelope = parseHarvest(harvestResult.value, route);
      return { ok: true as const, envelope };
    });
  } catch (err) {
    warnings.push(`browser-harness: withTab threw on ${route}: ${String(err)}`);
    return { ok: false, reason: 'camofox_tab_failure' };
  }
}

/**
 * V56.4.1 ships dormant — it implements the runner end-to-end but no
 * DETECTOR_CONTRACTS entry yet routes `'browser-mcp'` through it. V56.4.2+
 * adds per-detector contracts that flip the dispatch.
 *
 * The runner returns an envelope-keyed result; per-detector classifier
 * invocation is done by the caller (V56.4.2+ detector dispatchers in
 * test-detector.ts).
 */
export async function runBrowserHarness(opts: BrowserHarnessOptions): Promise<BrowserHarnessResult> {
  const { contract, target, browser, budgetMs, signal: parentSignal, observationWindowMsOverride } = opts;
  const startMs = Date.now();
  const warnings: string[] = [];
  const phasesRun: RequiredPhase[] = [];
  const envelopesByRoute = new Map<string, HarvestEnvelope>();

  // Combined budget signal
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);
  const combinedSignal = combineSignals(budgetController.signal, parentSignal);

  try {
    const observationWindowMs = computeObservationWindowMs(contract, observationWindowMsOverride);

    if (contract.requires.phases.includes('validate')) {
      phasesRun.push('validate');
    }

    if (combinedSignal.aborted) {
      return {
        clusters: [],
        phasesRun,
        envelopesByRoute,
        durationMs: Date.now() - startMs,
        budgetExceeded: true,
        warnings,
      };
    }

    if (contract.requires.phases.includes('execute')) {
      const routes = loadProbeRoutes(target.fixturePath, contract.kind);
      if (routes.length === 0) {
        warnings.push(`browser-harness: no probe routes loaded from ${target.fixturePath}/expected-clusters.jsonl`);
      }

      // Strategy: open ONE tab to about:blank, install the bootstrap as an init
      // script (camofox / CDP semantics: addScriptToEvaluateOnNewDocument runs on
      // every subsequent navigation BEFORE the page's own scripts), then navigate
      // the same tab to each fixture route in turn. Each navigation creates a
      // fresh window, the bootstrap fires before page scripts, console.error and
      // friends are intercepted, and we harvest after the settle window.
      //
      // Falls back to per-route withTab + post-navigate evaluate when the adapter
      // does not expose addInitScript or openTab — load-time events may be missed
      // but everything later still works.
      const supportsInitScript = typeof browser.addInitScript === 'function';

      let firstSkipReason: BrowserHarnessSkipReason | undefined;

      if (supportsInitScript) {
        try {
          // Seed the tab via navigate() — this sets currentTabId on the adapter,
          // which addInitScript needs. We seed at the FIRST route URL so the
          // navigation is real. Load-time events for the first route are missed
          // on this seed pass, but every subsequent navigate runs the init script
          // before page scripts and captures cleanly.
          const seedRoute = routes[0];
          if (seedRoute === undefined) {
            // No routes — already warned; nothing more to do.
          } else {
            const seedUrl = `${target.appBaseUrl}${seedRoute}`;
            const seedNav = await browser.navigate(seedUrl).catch((err: unknown) => {
              warnings.push(`browser-harness: seed navigate(${seedRoute}) threw: ${String(err)}`);
              return null;
            });
            if (seedNav === null) {
              firstSkipReason = 'camofox_tab_failure';
            } else {
              const initResult = await browser.addInitScript!(BOOTSTRAP_INSTALL_SCRIPT).catch((err: unknown) => {
                warnings.push(`browser-harness: addInitScript threw: ${String(err)}`);
                return null;
              });
              const installedAsInit = initResult !== null && initResult.applied;
              if (initResult !== null && initResult.degraded === 'late_inject') {
                warnings.push('browser-harness: addInitScript degraded to late-inject — load-time events may be missed');
              }

              for (const route of routes) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (combinedSignal.aborted) break;
                const fullUrl = `${target.appBaseUrl}${route}`;
                const navResult = await browser.navigate(fullUrl).catch((err: unknown) => {
                  warnings.push(`browser-harness: navigate(${route}) threw: ${String(err)}`);
                  return null;
                });
                if (navResult === null) {
                  if (firstSkipReason === undefined) firstSkipReason = 'camofox_tab_failure';
                  continue;
                }

                // If addInitScript wasn't applied as an init-script, install via
                // evaluate now (best-effort, may miss load-time events).
                if (!installedAsInit) {
                  await browser.evaluate(BOOTSTRAP_INSTALL_SCRIPT).catch(() => {});
                }

                try {
                  await sleep(observationWindowMs, combinedSignal);
                } catch {
                  if (firstSkipReason === undefined) firstSkipReason = 'observation_window_exceeded';
                  continue;
                }

                const harvestResult = await browser.evaluate(HARVEST_SCRIPT).catch((err: unknown) => {
                  warnings.push(`browser-harness: harvest(${route}) threw: ${String(err)}`);
                  return null;
                });
                if (harvestResult === null) {
                  if (firstSkipReason === undefined) firstSkipReason = 'camofox_tab_failure';
                  continue;
                }

                const envelope = parseHarvest(harvestResult.value, route);
                envelopesByRoute.set(route, envelope);
                log.info(`browser-harness: probe ${contract.kind}`, {
                  route,
                  consoleEvents: envelope.consoleEvents.length,
                  uncaughtErrors: envelope.uncaughtErrors.length,
                  performanceEntries: envelope.performanceEntries.length,
                  axeViolations: envelope.axeViolations.length,
                });
              }
            }
          }
        } finally {
          // No explicit tab cleanup. Camofox treats the tab as a session-shared
          // singleton; closing it tears down the browser context for unrelated
          // callers. Tests run sequentially so the next test-detector invocation
          // re-navigates as needed.
        }
      } else {
        // Legacy / mock adapters: per-route withTab + post-navigate evaluate.
        warnings.push('browser-harness: adapter lacks openTab/addInitScript/closeTabExplicit — falling back to per-route withTab (load-time events may be missed)');
        for (const route of routes) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (combinedSignal.aborted) break;
          const fullUrl = `${target.appBaseUrl}${route}`;
          const result = await probeRoute(browser, fullUrl, route, observationWindowMs, combinedSignal, warnings, false);
          if (result.ok) {
            envelopesByRoute.set(route, result.envelope);
            log.info(`browser-harness: probe ${contract.kind}`, {
              route,
              consoleEvents: result.envelope.consoleEvents.length,
              uncaughtErrors: result.envelope.uncaughtErrors.length,
              performanceEntries: result.envelope.performanceEntries.length,
            });
          } else {
            if (firstSkipReason === undefined) firstSkipReason = result.reason;
          }
        }
      }

      phasesRun.push('execute');

      // If every route failed and none produced an envelope, surface as a single
      // skip reason so the caller can map to expect:'skipped'.
      if (envelopesByRoute.size === 0 && firstSkipReason !== undefined) {
        return {
          clusters: [],
          phasesRun,
          envelopesByRoute,
          durationMs: Date.now() - startMs,
          budgetExceeded: combinedSignal.aborted,
          warnings,
          skipReason: firstSkipReason,
        };
      }
    }

    if (contract.requires.phases.includes('classify')) phasesRun.push('classify');
    if (contract.requires.phases.includes('cluster')) phasesRun.push('cluster');

    return {
      clusters: [],
      phasesRun,
      envelopesByRoute,
      durationMs: Date.now() - startMs,
      budgetExceeded: combinedSignal.aborted,
      warnings,
    };
  } finally {
    clearTimeout(budgetTimer);
  }
}

// ---------------------------------------------------------------------------
// AbortSignal combiner — same shape as executor.ts but local to keep the
// browser-executor self-contained for the V56.4.1 ship-dormant gate.
// ---------------------------------------------------------------------------

function combineSignals(budget: AbortSignal, parent?: AbortSignal): AbortSignal {
  if (parent === undefined) return budget;
  if (budget.aborted || parent.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const c = new AbortController();
  budget.addEventListener('abort', () => c.abort(), { once: true });
  parent.addEventListener('abort', () => c.abort(), { once: true });
  return c.signal;
}

// ---------------------------------------------------------------------------
// Cluster builder — utility for V56.4.2+ detector dispatchers that consume
// envelopes and produce BugCluster[] in the V56.3-compatible shape.
// ---------------------------------------------------------------------------

export function buildBrowserHarnessCluster(
  kind: BugKind,
  page: string,
  rootCause: string,
  severity: 'critical' | 'major' | 'minor' | 'info',
): BugCluster {
  const now = new Date().toISOString();
  const occurrence: Occurrence = {
    occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
    role: 'anonymous',
    page,
    action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
    fullArtifacts: false as const,
    timestamp: now,
  };
  return {
    id: `harness-${kind}-${page.replace(/\//g, '-')}`,
    runId: 'harness',
    kind,
    rootCause,
    firstSeenAt: now,
    lastSeenAt: now,
    clusterSize: 1,
    occurrences: [occurrence],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    severity,
  };
}
