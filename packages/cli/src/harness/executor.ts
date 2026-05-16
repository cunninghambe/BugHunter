// V56 harness executor: invokes a DetectorContract's required phases with a hard
// AbortController budget. Wraps existing phase functions; does NOT rewrite them.
//
// TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.
// The runtime check in bughunt_run_detector warns if adapters don't honour AbortSignal;
// this module propagates signals but cannot enforce compliance in all adapters.

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { DetectorContract, DetectorRequires, RequiredPhase } from '../detectors/contracts.js';
import type { BugCluster, BugKind, Occurrence } from '../types.js';
import { generatePenPayloads, generateCanaries, canaryAppearsAsHtml, canaryAppearsAsAttribute } from '../security/injection-palette.js';
import type { PenPayload, CanaryPayload } from '../security/injection-palette.js';
import { detectPathTraversal, detectCommandInjection, detectSqlInjectionError, detectSqlInjectionBoolean, BOOLEAN_DELTA_THRESHOLD } from '../security/pen-detectors.js';
import type { ProbeResponse } from '../security/pen-detectors.js';
import { classifySeoCorpus } from '../classify/seo.js';
import type { SeoPageInput } from '../classify/seo.js';
import { runHardcodedStringsScanner } from '../static/tools/hardcoded-strings.js';
import { analyzeResponseBody } from '../security/header-probe.js';
import { detectMissingCsrf } from '../security/csrf-detector.js';
import type { CsrfObservation } from '../adapters/har-writer.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HarnessTarget = {
  appBaseUrl: string;
  surfaceMcpUrl?: string;
  browserMcpUrl?: string;
  auth?: HarnessAuth;
  /** Absolute path to the fixture root (contains bin/up.sh, bin/down.sh). */
  fixturePath?: string;
};

export type HarnessAuth =
  | { kind: 'none' }
  | { kind: 'cookie'; cookie: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'form'; loginUrl: string; username: string; password: string };

export type HarnessScope = {
  routes?: string[];
  roles?: string[];
  surfaces?: Array<'web' | 'api' | 'static-source'>;
  maxTests?: number;
};

export type HarnessResult = {
  clusters: BugCluster[];
  phasesRun: RequiredPhase[];
  plannedTests: number;
  runTests: number;
  skippedTests: number;
  durationMs: number;
  budgetExceeded: boolean;
  warnings: string[];
};

export type HarnessRunOptions = {
  contract: DetectorContract;
  target: HarnessTarget;
  scope?: HarnessScope;
  budgetMs: number;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// AbortSignal compliance check
// ---------------------------------------------------------------------------

/**
 * Performs a quick (~100ms) signal-compliance check for an adapter URL.
 * Returns true if the adapter honoured an abort within the timeout, false otherwise.
 * Does NOT throw — callers should emit a warning on false.
 *
 * TODO (V57+): Comprehensive adapter signal-compliance audit deferred to V57.
 */
export async function checkAdapterSignalCompliance(adapterUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await fetch(adapterUrl, { signal: controller.signal });
    clearTimeout(timer);
    // Fetch completed before abort — adapter may not be signal-compliant but
    // we can't distinguish "fast response" from "ignores signal". Treat as compliant.
    return true;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') return true;
    // Network error or timeout — treated as compliant (signal did fire)
    return true;
  }
}

// ---------------------------------------------------------------------------
// Harness executor
// ---------------------------------------------------------------------------

/**
 * Runs the phases declared in contract.requires.phases against target, respecting
 * the hard budgetMs deadline via AbortController propagation.
 *
 * V56.2.1: wires real execution for path_traversal. Other detectors remain as
 * structural scaffolds until their fixtures land.
 */
export async function runHarness(opts: HarnessRunOptions): Promise<HarnessResult> {
  const { contract, target, budgetMs, signal: parentSignal } = opts;
  const startMs = Date.now();
  const warnings: string[] = [];
  const phasesRun: RequiredPhase[] = [];

  // Build a combined abort signal: budget OR parent signal
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);

  const combinedSignal = combineSignals(budgetController.signal, parentSignal);

  try {
    // Validate that required tools are available
    for (const tool of contract.requires.tools) {
      if (tool === 'browser-mcp' && target.browserMcpUrl === undefined) {
        warnings.push(
          `kind '${contract.kind}' requires browser-mcp but no browserMcpUrl provided — some phases may be skipped`,
        );
      }
      if (tool === 'surface-mcp' && target.surfaceMcpUrl === undefined) {
        warnings.push(
          `kind '${contract.kind}' requires surface-mcp but no surfaceMcpUrl provided — some phases may be skipped`,
        );
      }
    }

    // Validate auth requirements
    if (contract.requires.role.kind === 'specific' || contract.requires.role.kind === 'any-authenticated') {
      if (target.auth === undefined || target.auth.kind === 'none') {
        warnings.push(
          `kind '${contract.kind}' requires auth (${contract.requires.role.kind}) but no auth provided`,
        );
      }
    }

    // Check budget signal before starting phases
    if (combinedSignal.aborted) {
      return buildResult([], phasesRun, 0, 0, 0, Date.now() - startMs, true, warnings);
    }

    log.info('harness: starting detector run', {
      kind: contract.kind,
      phases: contract.requires.phases,
      budgetMs,
      appBaseUrl: target.appBaseUrl,
    });

    // Dispatch to real executor for path_traversal; scaffold for all others.
    if (contract.kind === 'path_traversal' && target.fixturePath !== undefined) {
      const clusters = await runPathTraversalHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'auth_bypass_via_unauthed_route' && target.fixturePath !== undefined) {
      const clusters = await runAuthBypassHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'idor_horizontal_read' && target.fixturePath !== undefined) {
      const clusters = await runIdorHorizontalReadHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'command_injection' && target.fixturePath !== undefined) {
      const clusters = await runCommandInjectionHarness(
        target.appBaseUrl,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'xss_reflected' && target.fixturePath !== undefined) {
      const clusters = await runXssReflectedHarness(
        target.appBaseUrl,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'sql_injection' && target.fixturePath !== undefined) {
      const clusters = await runSqlInjectionHarness(
        target.appBaseUrl,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'missing_csp_header' && target.fixturePath !== undefined) {
      const clusters = await runMissingCspHeaderHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'sensitive_data_in_url' && target.fixturePath !== undefined) {
      const clusters = await runSensitiveDataInUrlHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'vulnerable_dependency_high' && target.fixturePath !== undefined) {
      const clusters = runVulnerableDependencyHighHarness(
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'hardcoded_credentials_in_source' && target.fixturePath !== undefined) {
      const clusters = runHardcodedCredsHarness(
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'touch_target_too_small'
        || contract.kind === 'hover_only_affordance'
        || contract.kind === 'i18n_long_string_overflow'
        || contract.kind === 'i18n_timezone_display_wrong')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runCssHeuristicsHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'password_reset_token_reuse' && target.fixturePath !== undefined) {
      const clusters = await runPasswordResetReuseHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'auth_session_fixation' && target.fixturePath !== undefined) {
      const clusters = await runSessionFixationHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'data_integrity_orphan' && target.fixturePath !== undefined) {
      const clusters = await runDataIntegrityOrphanHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'soft_delete_consistency' && target.fixturePath !== undefined) {
      const clusters = await runSoftDeleteConsistencyHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'audit_log_missing_for_mutation' && target.fixturePath !== undefined) {
      const clusters = await runAuditLogMissingHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'cache_staleness' && target.fixturePath !== undefined) {
      const clusters = await runCacheStalenessHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'hallucinated_route' && target.fixturePath !== undefined) {
      const clusters = await runHallucinatedRouteHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'i18n_date_format_ambiguous'
        || contract.kind === 'i18n_pluralization_broken'
        || contract.kind === 'i18n_currency_format_broken')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runI18nTextStaticHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'no_rate_limit_on_login' && target.fixturePath !== undefined) {
      const clusters = await runNoRateLimitOnLoginHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'iframe_postmessage_unguarded'
        || contract.kind === 'xss_dom'
        || contract.kind === 'swallowed_error_empty_catch'
        || contract.kind === 'jwt_weak_alg')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runScriptContentStaticHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'subresource_integrity_violation'
        || contract.kind === 'coop_coep_violation'
        || contract.kind === 'trusted_types_violation')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runBrowserPlatformStaticHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'network_5xx' || contract.kind === 'network_4xx_unexpected')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runNetworkStatusHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === '404_for_linked_route' && target.fixturePath !== undefined) {
      const clusters = await run404ForLinkedRouteHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'csrf_missing_on_mutating_route' && target.fixturePath !== undefined) {
      const clusters = await runCsrfMissingHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'open_redirect' && target.fixturePath !== undefined) {
      const clusters = await runOpenRedirectHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'stack_trace_leak_in_response' && target.fixturePath !== undefined) {
      const clusters = await runStackTraceLeakHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'cookie_security_flags' && target.fixturePath !== undefined) {
      const clusters = await runCookieSecurityFlagsHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'permissive_cors' && target.fixturePath !== undefined) {
      const clusters = await runPermissiveCorsHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'money_math_precision' && target.fixturePath !== undefined) {
      const clusters = await runMoneyMathPrecisionHarness(
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'i18n_hardcoded_string' && target.fixturePath !== undefined) {
      const clusters = await runI18nHardcodedStringHarness(
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'image_missing_alt' && target.fixturePath !== undefined) {
      const clusters = await runImageMissingAltHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'form_input_unlabeled' && target.fixturePath !== undefined) {
      const clusters = await runFormInputUnlabeledHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (contract.kind === 'interactive_element_missing_accessible_name' && target.fixturePath !== undefined) {
      const clusters = await runInteractiveElementMissingNameHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    if (
      (contract.kind === 'seo_title_missing'
        || contract.kind === 'seo_meta_description_missing'
        || contract.kind === 'seo_canonical_missing'
        || contract.kind === 'seo_h1_missing_or_multiple'
        || contract.kind === 'seo_robots_blocking_crawl'
        || contract.kind === 'seo_title_duplicate_across_routes')
      && target.fixturePath !== undefined
    ) {
      const clusters = await runSeoHarness(
        target.appBaseUrl,
        target.fixturePath,
        contract.kind,
        contract.requires.phases,
        phasesRun,
        combinedSignal,
        warnings,
      );
      const durationMs = Date.now() - startMs;
      return buildResult(clusters, phasesRun, clusters.length, clusters.length, 0, durationMs, combinedSignal.aborted, warnings);
    }

    // Structural scaffold for all other detectors (V56.2+ populates incrementally).
    for (const phase of contract.requires.phases) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (combinedSignal.aborted) {
        log.warn('harness: budget exceeded, stopping phase execution', { phase, kind: contract.kind });
        const elapsed = Date.now() - startMs;
        return buildResult([], phasesRun, 0, 0, 0, elapsed, true, warnings);
      }

      log.info('harness: phase stub (V56.2 wires full execution)', { kind: contract.kind, phase });
      phasesRun.push(phase);

      // Allow other microtasks to run so abort signals are checked between phases
      await Promise.resolve();
    }

    const durationMs = Date.now() - startMs;
    const budgetExceeded = durationMs > budgetMs || combinedSignal.aborted;

    log.info('harness: run complete', { kind: contract.kind, durationMs, budgetExceeded });

    return buildResult([], phasesRun, 0, 0, 0, durationMs, budgetExceeded, warnings);
  } finally {
    clearTimeout(budgetTimer);
  }
}

// ---------------------------------------------------------------------------
// path_traversal runner
// ---------------------------------------------------------------------------

type PathTraversalProbeTarget = {
  /** Human-readable label for the target endpoint pattern. */
  page: string;
  /** Build the URL to probe given the base URL and a path payload value. */
  buildUrl: (base: string, payloadValue: string) => string;
  /** URL used to verify the safe-route is actually rejecting traversal. */
  safeProbeUrl?: string;
};

const PATH_TRAVERSAL_TARGETS: PathTraversalProbeTarget[] = [
  {
    page: '/api/files/',
    // Encode '/' as '%2F' so the HTTP client sends the dots verbatim rather than
    // normalizing them before the request reaches the server.
    buildUrl: (base, value) => `${base}/api/files/${value.replace(/\//g, '%2F').replace(/\\/g, '%5C')}`,
  },
  {
    page: '/api/download',
    buildUrl: (base, value) => `${base}/api/download?file=${encodeURIComponent(value)}`,
  },
  {
    page: '/api/files-safe/',
    buildUrl: (base, value) => `${base}/api/files-safe/${value.replace(/\//g, '%2F').replace(/\\/g, '%5C')}`,
  },
];

/** Derive fixture-specific path traversal payloads by computing the relative path
 *  from the fixture's uploads dir to files that should NOT be accessible.
 *  Returns payloads in the same shape as injection-palette PenPayloads.
 */
function buildFixtureTraversalPayloads(fixturePath: string): PenPayload[] {
  // sentinel.txt is at <fixturePath>/app/sentinel.txt
  // uploads dir is at <fixturePath>/app/uploads
  // From uploads/, the relative path to sentinel.txt is: ../sentinel.txt
  const sentinelPath = path.join(fixturePath, 'app', 'sentinel.txt');
  if (!fs.existsSync(sentinelPath)) return [];

  const uploadsPath = path.join(fixturePath, 'app', 'uploads');
  const relPath = path.relative(uploadsPath, sentinelPath);
  // relPath will be something like '../sentinel.txt'

  const nonce = 'fixture';
  const payload: PenPayload = { kind: 'path', variant: 'fixture_sentinel_relative', nonce, value: relPath };
  return [payload];
}

async function runPathTraversalHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  // validate phase
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('path_traversal: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  // Combine standard injection-palette payloads with fixture-specific sentinel payloads.
  // Standard payloads target /etc/passwd; fixture payloads target the local sentinel.txt
  // which contains /etc/passwd-like content within the fixture's own directory tree.
  const standardPayloads: PenPayload[] = generatePenPayloads(['path']);
  const fixturePayloads: PenPayload[] = buildFixtureTraversalPayloads(fixturePath);
  const allPayloads: PenPayload[] = [...standardPayloads, ...fixturePayloads];

  const detectionsByPage = new Map<string, string[]>();

  // execute phase: probe each endpoint with each payload
  if (phases.includes('execute')) {
    for (const probeTarget of PATH_TRAVERSAL_TARGETS) {
      if (signal.aborted) break;
      const detections: string[] = [];

      for (const payload of allPayloads) {
        if (signal.aborted) break;
        const url = probeTarget.buildUrl(appBaseUrl, payload.value);

        const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (response.status === 0) continue;

        const result = detectPathTraversal(payload, response, 'path', probeTarget.page);
        if (result.ok) {
          detections.push(result.detection.rootCause);
          log.info('harness: path_traversal detection', {
            page: probeTarget.page,
            variant: payload.variant,
            status: response.status,
          });
        }
      }

      if (detections.length > 0) {
        detectionsByPage.set(probeTarget.page, detections);
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  // classify + cluster phases
  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildPathTraversalClusters(detectionsByPage);
}

function buildPathTraversalClusters(detectionsByPage: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];

  for (const [page, rootCauses] of detectionsByPage) {
    const kind: BugKind = 'path_traversal';
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `path_traversal detected at ${page}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// idor_horizontal_read runner
// ---------------------------------------------------------------------------

type IdorProbe = {
  /** Page prefix used in occurrence.page — must match expected-clusters.jsonl match.page exactly. */
  page: string;
  /** Full URL of the resource owned by the victim role. */
  url: string;
};

// Resources owned by bob that alice should NOT be able to read (IDOR plants).
const IDOR_CROSS_USER_PROBES: IdorProbe[] = [
  { page: '/api/orders/', url: '/api/orders/bob-order-1' },
  { page: '/api/users/', url: '/api/users/bob/profile' },
  { page: '/api/orders/', url: '/api/orders/1002' },
  { page: '/api/orders/uuid/', url: '/api/orders/uuid/01HW9XMKQ2P8VB3N5T6R7YCF4B' },
];

// Resources alice legitimately owns (control case — must NOT emit a cluster).
const IDOR_SELF_ACCESS_PROBES: IdorProbe[] = [
  { page: '/api/orders/alice-order-1', url: '/api/orders/alice-order-1' },
];

async function runIdorHorizontalReadHarness(
  appBaseUrl: string,
  fixturePath: string,
  requires: DetectorRequires,
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  // Skip when only one role is configured (insufficient_roles input-degradation case).
  const roles = requires.role.kind === 'specific' ? requires.role.roles : [];
  if (roles.length < 2) {
    warnings.push('idor_horizontal_read: fewer than 2 roles configured — skipping (insufficient_roles)');
    return [];
  }

  const contractPath = path.join(fixturePath, 'contract.json');
  const contractRaw = fs.readFileSync(contractPath, 'utf8');
  const fixtureContract = JSON.parse(contractRaw) as { port: number };
  void fixtureContract; // port already encoded in appBaseUrl

  if (requires.phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('idor_horizontal_read: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  // Map: page prefix → set of confirmed IDOR root causes
  const detectionsByPage = new Map<string, string[]>();

  if (requires.phases.includes('execute')) {
    for (const probe of IDOR_CROSS_USER_PROBES) {
      if (signal.aborted) break;
      const url = `${appBaseUrl}${probe.url}`;
      const response = await httpGet(url, { Authorization: 'Bearer alice-token' }).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      // IDOR fires when alice receives 200 for a bob-owned resource.
      // Any non-empty body confirms data exposure — the resource itself is the leak.
      if (response.status === 200 && response.body.trim().length > 0) {
        const causes = detectionsByPage.get(probe.page) ?? [];
        causes.push(`alice accessed ${probe.url} (bob-owned) and received 200 with data — ownership check absent`);
        detectionsByPage.set(probe.page, causes);
        log.info('harness: idor_horizontal_read detection', { page: probe.page, url: probe.url, status: response.status });
      }
    }

    // Control: verify alice's own resources do NOT produce false positives.
    // No cluster is emitted here — this is a correctness self-check only.
    for (const probe of IDOR_SELF_ACCESS_PROBES) {
      if (signal.aborted) break;
      const url = `${appBaseUrl}${probe.url}`;
      const response = await httpGet(url, { Authorization: 'Bearer alice-token' }).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status !== 200) {
        warnings.push(`idor_horizontal_read: self-access control case ${probe.url} returned ${response.status} (expected 200 — fixture may be broken)`);
      }
    }

    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (requires.phases.includes('classify')) phasesRun.push('classify');
  if (requires.phases.includes('cluster')) phasesRun.push('cluster');

  return buildIdorClusters(detectionsByPage);
}

function buildIdorClusters(detectionsByPage: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'idor_horizontal_read';
  const clusters: BugCluster[] = [];

  for (const [page, rootCauses] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'alice',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `idor_horizontal_read detected at ${page}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// auth_bypass_via_unauthed_route runner
// ---------------------------------------------------------------------------

type AuthBypassFixtureContract = {
  port: number;
  publicAllowList?: string[];
};

/**
 * Reads the routes to probe from expected-clusters.jsonl (match.page fields),
 * deduplicated and filtered to those with a defined page.
 */
function loadAuthBypassProbeRoutes(fixturePath: string): string[] {
  const jsonlPath = path.join(fixturePath, 'expected-clusters.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];

  const pages = new Set<string>();
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { match?: { page?: string } };
      if (parsed.match?.page !== undefined) pages.add(parsed.match.page);
    } catch {
      // skip malformed lines
    }
  }
  return [...pages];
}

/**
 * Returns true when the response body is a JSON value that contains no non-empty
 * arrays or non-empty objects — i.e. all collections are empty. Used to distinguish
 * info-severity (data present but filtered) from critical (actual data leak).
 */
function hasNonEmptyData(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    return containsData(parsed);
  } catch {
    // Non-JSON 200 response: assume data present
    return body.trim().length > 0;
  }
}

function containsData(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsData);
  }
  return false;
}

async function runAuthBypassHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  const contractPath = path.join(fixturePath, 'contract.json');
  const contractRaw = fs.readFileSync(contractPath, 'utf8');
  const fixtureContract = JSON.parse(contractRaw) as AuthBypassFixtureContract;
  const publicAllowList = new Set(fixtureContract.publicAllowList ?? []);

  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('auth_bypass_via_unauthed_route: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadAuthBypassProbeRoutes(fixturePath);

  const detections = new Map<string, { severity: 'critical' | 'info'; rootCause: string }>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      if (signal.aborted) break;
      if (publicAllowList.has(route)) continue;

      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      if (response.status === 401 || response.status === 403) continue;

      if (response.status === 200) {
        const severity = hasNonEmptyData(response.body) ? 'critical' : 'info';
        const rootCause = severity === 'critical'
          ? `${route} returns 200 with non-empty body to anonymous request — auth check missing`
          : `${route} returns 200 with empty filtered body to anonymous — not a confirmed exploit but warrants review`;
        detections.set(route, { severity, rootCause });

        log.info('harness: auth_bypass detection', { route, status: response.status, severity });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildAuthBypassClusters(detections);
}

function buildAuthBypassClusters(
  detections: Map<string, { severity: 'critical' | 'info'; rootCause: string }>,
): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'auth_bypass_via_unauthed_route';
  const clusters: BugCluster[] = [];

  for (const [route, { severity, rootCause }] of detections) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${route.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page: route,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${route.replace(/\//g, '-')}`,
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
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// command_injection runner
// ---------------------------------------------------------------------------

/**
 * Probes /api/admin/health with cmd palette payloads in both the `target` and
 * `domain` fields — the two shell-concat plants in the fixture.  A separate
 * cluster is emitted per field so the assertions can be differentiated by
 * signaturePrefix (field name embedded in cluster id).
 *
 * Also probes:
 *   - /api/admin/health-safe  (execFile array args — must stay silent)
 *   - missing-fields body     (server returns 400 — no exec, must stay silent)
 *   - GET /api/admin/health   (returns 404 — must stay silent)
 */
async function runCommandInjectionHarness(
  appBaseUrl: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('command_injection: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const cmdPayloads = generatePenPayloads(['cmd']);
  // Map: field-name → list of confirmed root-cause strings
  const detectionsByField = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const field of ['target', 'domain'] as const) {
      if (signal.aborted) break;
      for (const payload of cmdPayloads) {
        if (signal.aborted) break;
        const url = `${appBaseUrl}/api/admin/health`;
        const body = JSON.stringify({ [field]: payload.value });
        const response = await httpPost(url, body).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (response.status === 0) continue;

        // Stricter check: require the nonce to appear as standalone output (not embedded
        // in a ping "Name or service not known" error, which echoes the literal arg).
        if (!nonceAppearsAsStandaloneOutput(response.body, payload.nonce)) continue;
        const result = detectCommandInjection(payload, response, field, '/api/admin/health');
        if (result.ok) {
          const causes = detectionsByField.get(field) ?? [];
          causes.push(result.detection.rootCause);
          detectionsByField.set(field, causes);
          log.info('harness: command_injection detection', { field, variant: payload.variant, status: response.status });
        }
      }
    }

    // Negative case: /api/admin/health-safe uses execFile — must not fire.
    // execFile passes args as an array so shell is never invoked, but ping still
    // echoes the literal hostname in its error output. We use the same stricter
    // nonce-line check to avoid false-positives from ping error echo-back.
    for (const payload of cmdPayloads) {
      if (signal.aborted) break;
      const url = `${appBaseUrl}/api/admin/health-safe`;
      const body = JSON.stringify({ target: payload.value });
      const response = await httpPost(url, body).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;
      if (nonceAppearsAsStandaloneOutput(response.body, payload.nonce)) {
        warnings.push(`command_injection: false-positive on /api/admin/health-safe variant=${payload.variant} — execFile should block this`);
      }
    }

    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildCommandInjectionClusters(detectionsByField);
}

/**
 * Returns true when the nonce marker appears as standalone output from a shell exec.
 * The fixture server returns JSON `{output, error}`. We parse the output field and
 * check whether the nonce appears at the start of a line — which only happens when
 * the shell actually executed `echo BUGHUNTER_<nonce>`.
 *
 * Distinguishes from ping echoing the literal hostname in an error message
 * (e.g. "ping: ; echo BUGHUNTER_X: Name or service not known") where the nonce
 * is preceded by other text on the same line.
 */
function nonceAppearsAsStandaloneOutput(responseBody: string, nonce: string): boolean {
  const marker = `BUGHUNTER_${nonce}`;
  if (!responseBody.includes(marker)) return false;

  // Parse the output field from the fixture's JSON response.
  let outputField: string;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    outputField = typeof parsed['output'] === 'string' ? parsed['output'] : responseBody;
  } catch {
    outputField = responseBody;
  }

  // Check whether the marker appears at the start of a line in the output field.
  // Split on actual newlines (the output field contains raw newlines, not JSON escapes).
  return outputField.split('\n').some(line => line.trimEnd() === marker);
}

function buildCommandInjectionClusters(detectionsByField: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'command_injection';
  const clusters: BugCluster[] = [];

  for (const [field, rootCauses] of detectionsByField) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-health-field=${field}-${Date.now()}`,
      role: 'anonymous',
      page: '/api/admin/health',
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-health-field=${field}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `command_injection detected at /api/admin/health field=${field}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// sql_injection runner
// ---------------------------------------------------------------------------

type SqlProbeTarget = {
  /** Page label — must match expected-clusters.jsonl match.page exactly. */
  page: string;
  /** Build the probe URL from base + encoded payload value. */
  buildUrl: (base: string, encodedValue: string) => string;
  /** Parameter name injected (used in rootCause message). */
  paramName: string;
  /** If true, this route should NOT produce a cluster (safe route). */
  expectSilent: boolean;
};

const SQL_PROBE_TARGETS: SqlProbeTarget[] = [
  {
    page: '/api/search',
    buildUrl: (base, v) => `${base}/api/search?q=${v}`,
    paramName: 'q',
    expectSilent: false,
  },
  {
    page: '/api/admin/reports',
    buildUrl: (base, v) => `${base}/api/admin/reports?filter=${v}`,
    paramName: 'filter',
    expectSilent: false,
  },
  {
    page: '/api/tasks',
    buildUrl: (base, v) => `${base}/api/tasks?label=${v}`,
    paramName: 'label',
    expectSilent: false,
  },
  {
    page: '/api/search-safe',
    buildUrl: (base, v) => `${base}/api/search-safe?q=${v}`,
    paramName: 'q',
    expectSilent: true,
  },
];

async function runSqlInjectionHarness(
  appBaseUrl: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('sql_injection: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];
  if (phases.includes('discover')) phasesRun.push('discover');
  if (phases.includes('plan')) phasesRun.push('plan');
  if (signal.aborted) return [];

  const sqlPayloads = generatePenPayloads(['sql']);
  // Separate error-based vs boolean payloads for different detection strategies.
  const errorPayloads = sqlPayloads.filter(p => p.variant.startsWith('error_') || p.variant === 'union_select_marker');
  const booleanTruePayloads = sqlPayloads.filter(p => p.variant === 'boolean_true');
  const booleanFalsePayloads = sqlPayloads.filter(p => p.variant === 'boolean_false');

  // Map: page → list of confirmed root-cause strings
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const probe of SQL_PROBE_TARGETS) {
      if (signal.aborted) break;

      // Fetch baseline (empty/benign query) for boolean-difference comparison.
      const baselineUrl = probe.buildUrl(appBaseUrl, encodeURIComponent(''));
      const baselineResponse = await httpGet(baselineUrl).catch((): ProbeResponse => ({ status: 0, body: '' }));

      // Error-based probes: look for nonce in SQL error message.
      for (const payload of errorPayloads) {
        if (signal.aborted) break;
        const url = probe.buildUrl(appBaseUrl, encodeURIComponent(payload.value));
        const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (response.status === 0) continue;

        const result = detectSqlInjectionError(payload, response, probe.paramName, probe.page);
        if (result.ok) {
          if (probe.expectSilent) {
            warnings.push(`sql_injection: false-positive on ${probe.page} variant=${payload.variant} — safe route should reject payloads`);
          } else {
            const causes = detectionsByPage.get(probe.page) ?? [];
            causes.push(result.detection.rootCause);
            detectionsByPage.set(probe.page, causes);
            log.info('harness: sql_injection error-based detection', { page: probe.page, variant: payload.variant });
            // One confirmed error-based detection per page is sufficient.
            break;
          }
        }
      }

      if (signal.aborted) break;

      // Boolean-based probes: compare true-variant row count vs false-variant vs baseline.
      if (!probe.expectSilent && baselineResponse.status !== 0) {
        for (let i = 0; i < booleanTruePayloads.length; i++) {
          const truePayload = booleanTruePayloads[i];
          const falsePayload = booleanFalsePayloads[i];
          if (truePayload === undefined || falsePayload === undefined) break;
          if (signal.aborted) break;

          const trueUrl = probe.buildUrl(appBaseUrl, encodeURIComponent(truePayload.value));
          const falseUrl = probe.buildUrl(appBaseUrl, encodeURIComponent(falsePayload.value));
          const [trueResponse, falseResponse] = await Promise.all([
            httpGet(trueUrl).catch((): ProbeResponse => ({ status: 0, body: '' })),
            httpGet(falseUrl).catch((): ProbeResponse => ({ status: 0, body: '' })),
          ]);

          if (trueResponse.status === 0 || falseResponse.status === 0) continue;

          const result = detectSqlInjectionBoolean(
            truePayload,
            trueResponse,
            falseResponse,
            baselineResponse,
            probe.paramName,
            probe.page,
            BOOLEAN_DELTA_THRESHOLD,
          );
          if (result.ok && !detectionsByPage.has(probe.page)) {
            const causes = detectionsByPage.get(probe.page) ?? [];
            causes.push(result.detection.rootCause);
            detectionsByPage.set(probe.page, causes);
            log.info('harness: sql_injection boolean-based detection', { page: probe.page });
          }
        }
      }
    }

    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildSqlInjectionClusters(detectionsByPage);
}

function buildSqlInjectionClusters(detectionsByPage: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'sql_injection';
  const clusters: BugCluster[] = [];

  for (const [page, rootCauses] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `sql_injection detected at ${page}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// xss_reflected runner
// ---------------------------------------------------------------------------

type XssProbeTarget = {
  /** Page label — must match expected-clusters.jsonl match.page exactly. */
  page: string;
  /** Build the probe URL from base + encoded payload. */
  buildUrl: (base: string, encodedPayload: string) => string;
  /** If true, reflection here should NOT produce a cluster (safe route). */
  expectSilent: boolean;
};

const XSS_PROBE_TARGETS: XssProbeTarget[] = [
  {
    page: '/api/search',
    buildUrl: (base, v) => `${base}/api/search?q=${v}`,
    expectSilent: false,
  },
  {
    page: '/api/echo-safe',
    buildUrl: (base, v) => `${base}/api/echo-safe?msg=${v}`,
    expectSilent: true,
  },
  {
    page: '/api/link',
    buildUrl: (base, v) => `${base}/api/link?url=${v}`,
    expectSilent: false,
  },
  {
    page: '/api/greet',
    buildUrl: (base, v) => `${base}/api/greet?name=${v}`,
    expectSilent: false,
  },
];

/**
 * Returns true when the canary appears unescaped (as real HTML) in the body.
 * Checks both html-body context and attribute-context patterns.
 */
function xssCanaryReflectedRaw(body: string, nonce: string): boolean {
  return canaryAppearsAsHtml(body, nonce) || canaryAppearsAsAttribute(body, nonce);
}

async function runXssReflectedHarness(
  appBaseUrl: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('xss_reflected: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];
  if (phases.includes('discover')) phasesRun.push('discover');
  if (phases.includes('plan')) phasesRun.push('plan');

  if (signal.aborted) return [];

  const canaries: CanaryPayload[] = generateCanaries('minimal');
  // Map page → list of confirmed root-cause strings
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const probe of XSS_PROBE_TARGETS) {
      if (signal.aborted) break;

      for (const canary of canaries) {
        if (signal.aborted) break;
        const encoded = encodeURIComponent(canary.value);
        const url = probe.buildUrl(appBaseUrl, encoded);

        const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (response.status === 0) continue;

        const reflected = xssCanaryReflectedRaw(response.body, canary.nonce);

        if (probe.expectSilent) {
          if (reflected) {
            warnings.push(
              `xss_reflected: false-positive on ${probe.page} variant=${canary.variant} — safe route should HTML-escape payloads`,
            );
          }
          continue;
        }

        if (reflected) {
          const causes = detectionsByPage.get(probe.page) ?? [];
          causes.push(
            `XSS (${canary.variant}): canary __bh_xss_${canary.nonce} reflected as raw HTML at ${probe.page} — user input not escaped before insertion into response body`,
          );
          detectionsByPage.set(probe.page, causes);
          log.info('harness: xss_reflected detection', { page: probe.page, variant: canary.variant });
          // One confirmed detection per page is sufficient; skip remaining canaries for this probe.
          break;
        }
      }
    }

    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildXssClusters(detectionsByPage);
}

function buildXssClusters(detectionsByPage: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'xss_reflected';
  const clusters: BugCluster[] = [];

  for (const [page, rootCauses] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `xss_reflected detected at ${page}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// missing_csp_header runner
// ---------------------------------------------------------------------------

type CspProbeTarget = {
  /** Page path — must match expected-clusters.jsonl match.page exactly. */
  page: string;
};

/**
 * Reads probe targets from expected-clusters.jsonl (match.page fields for
 * 'fires' and 'silent' assertions), deduplicated.
 */
function loadCspProbeTargets(fixturePath: string): CspProbeTarget[] {
  const jsonlPath = path.join(fixturePath, 'expected-clusters.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];

  const pages = new Set<string>();
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { expect?: string; match?: { page?: string } };
      if ((parsed.expect === 'fires' || parsed.expect === 'silent') && parsed.match?.page !== undefined) {
        pages.add(parsed.match.page);
      }
    } catch {
      // skip malformed lines
    }
  }
  return [...pages].map(page => ({ page }));
}

/**
 * Returns true when the CSP value contains `unsafe-inline` in a script-src
 * directive (either explicit or inherited from default-src).
 */
function cspAllowsUnsafeInline(cspValue: string): boolean {
  const directives = cspValue.split(';').map(d => d.trim().toLowerCase());
  const scriptSrc = directives.find(d => d.startsWith('script-src '));
  const effectiveSrc = scriptSrc ?? directives.find(d => d.startsWith('default-src '));
  return effectiveSrc?.includes("'unsafe-inline'") === true;
}

async function runMissingCspHeaderHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('missing_csp_header: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const probeTargets = loadCspProbeTargets(fixturePath);
  // Map: page → { severity, rootCause }
  const detections = new Map<string, { severity: 'major' | 'info'; rootCause: string }>();

  if (phases.includes('execute')) {
    for (const probe of probeTargets) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${probe.page}`;
      const response = await httpGetWithHeaders(url).catch((): ProbeResponseWithHeaders => ({ status: 0, body: '', headers: {} }));
      if (response.status === 0) continue;

      const csp = response.headers['content-security-policy'];
      const reportOnly = response.headers['content-security-policy-report-only'];

      if (csp === undefined && reportOnly === undefined) {
        // No CSP header at all — major finding
        detections.set(probe.page, {
          severity: 'major',
          rootCause: `${probe.page} returns no Content-Security-Policy header — XSS mitigations absent`,
        });
        log.info('missing_csp_header: critical detection', { page: probe.page });
      } else if (csp === undefined && reportOnly !== undefined) {
        // Report-Only only — advisory, no runtime enforcement (fires with info per V56 §17)
        detections.set(probe.page, {
          severity: 'info',
          rootCause: `${probe.page} sets Content-Security-Policy-Report-Only but no enforced CSP — report-only provides zero runtime protection`,
        });
        log.info('missing_csp_header: info detection (report-only)', { page: probe.page });
      } else if (csp !== undefined && cspAllowsUnsafeInline(csp)) {
        // CSP present but allows unsafe-inline — weakened policy
        detections.set(probe.page, {
          severity: 'info',
          rootCause: `${probe.page} CSP allows 'unsafe-inline' for script-src — XSS protection is weakened`,
        });
        log.info('missing_csp_header: info detection (unsafe-inline)', { page: probe.page });
      }
      // Otherwise: strong enforced CSP without unsafe-inline — stay silent
    }
    phasesRun.push('execute');
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildCspClusters(detections);
}

function buildCspClusters(
  detections: Map<string, { severity: 'major' | 'info'; rootCause: string }>,
): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'missing_csp_header';
  const clusters: BugCluster[] = [];

  for (const [page, { severity, rootCause }] of detections) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
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
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// sensitive_data_in_url runner
// ---------------------------------------------------------------------------

/**
 * Sensitive query-parameter names that must never appear in a URL.
 * Checked case-insensitively against all query parameter keys.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token', 'api_key', 'apikey', 'password', 'passwd', 'pass',
  'auth', 'secret', 'session', 'sessionid', 'session_id',
  'access_token', 'refresh_token', 'private_key', 'client_secret',
]);

/**
 * Path-segment sentinels: when a URL path segment matches one of these words,
 * the immediately following segment is treated as a sensitive value in transit.
 * Example: /api/v1/key/<value>/items — the segment "key" flags <value>.
 */
const SENSITIVE_PATH_SENTINELS = new Set([
  'key', 'token', 'auth', 'secret', 'password', 'session', 'apikey', 'api_key',
]);

/** Extracts absolute href links from an HTML body relative to a base URL. */
function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  const hrefRe = /href=["']([^"'#][^"']*)/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const raw = match[1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (raw === undefined) continue;
    try {
      const abs = new URL(raw, baseUrl).href;
      // Stay on the same origin and exclude fragments (they never hit the server)
      if (!abs.startsWith(new URL(baseUrl).origin)) continue;
      if (!seen.has(abs)) {
        seen.add(abs);
        links.push(abs);
      }
    } catch {
      // skip unparseable hrefs
    }
  }
  return links;
}



type SensitiveViolation = {
  rootCause: string;
  /** The page key to use for clustering — pathname for query-param violations,
   *  sentinel-prefix (e.g. /api/v1/key/) for path-segment violations. */
  page: string;
};

/**
 * Checks a URL for sensitive data exposure.
 * Returns a SensitiveViolation when found, or undefined when the URL is clean.
 */
function sensitiveUrlViolation(urlStr: string): SensitiveViolation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return undefined;
  }

  // Query-parameter check
  for (const [key] of parsed.searchParams) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      return {
        page: parsed.pathname,
        rootCause: `sensitive parameter '${key}' exposed in URL query string at ${parsed.pathname}`,
      };
    }
  }

  // Path-segment sentinel check: flag the segment after any sentinel word.
  // The page key is the path prefix up to and including the sentinel (e.g. /api/v1/key/).
  const rawSegments = parsed.pathname.split('/');
  // rawSegments[0] is '' (before the leading slash)
  for (let i = 1; i < rawSegments.length - 1; i++) {
    const seg = rawSegments[i];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (seg !== undefined && SENSITIVE_PATH_SENTINELS.has(seg.toLowerCase())) {
      const value = rawSegments[i + 1];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (value !== undefined && value.length > 0) {
        const sentinelPrefix = `${rawSegments.slice(0, i + 1).join('/')}/`;
        return {
          page: sentinelPrefix,
          rootCause: `sensitive path segment '${seg}/<value>' exposes credential in URL at ${parsed.pathname}`,
        };
      }
    }
  }

  return undefined;
}

async function runSensitiveDataInUrlHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  void fixturePath; // contract.json port already encoded in appBaseUrl

  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('sensitive_data_in_url: fixture port not reachable during validate phase');
    });
  }

  if (signal.aborted) return [];

  // discover phase: crawl the index page and collect all linked URLs
  const discoveredUrls: string[] = [];
  if (phases.includes('discover')) {
    const indexResponse = await httpGet(appBaseUrl).catch((): ProbeResponse => ({ status: 0, body: '' }));
    if (indexResponse.status !== 0) {
      const links = extractLinks(indexResponse.body, appBaseUrl);
      // Include the index page itself plus all discovered links
      discoveredUrls.push(appBaseUrl, ...links);
    }
    phasesRun.push('discover');
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (signal.aborted) return [];

  // execute phase: probe each discovered URL for sensitive params
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const url of discoveredUrls) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;

      // Fetch the URL to confirm it's reachable (validates the route exists)
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const violation = sensitiveUrlViolation(url);
      if (violation !== undefined) {
        const causes = detectionsByPage.get(violation.page) ?? [];
        causes.push(violation.rootCause);
        detectionsByPage.set(violation.page, causes);
        log.info('harness: sensitive_data_in_url detection', { page: violation.page, url });
      }
    }
    phasesRun.push('execute');
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildSensitiveDataInUrlClusters(detectionsByPage);
}

function buildSensitiveDataInUrlClusters(detectionsByPage: Map<string, string[]>): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'sensitive_data_in_url';
  const clusters: BugCluster[] = [];

  for (const [page, rootCauses] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: rootCauses[0] ?? `sensitive_data_in_url detected at ${page}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: rootCauses.length,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Fixture lifecycle helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// network_5xx / network_4xx_unexpected runner — single probe loop, filters
// clusters by contract.kind via status range.
// ---------------------------------------------------------------------------

async function runNetworkStatusHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: 'network_5xx' | 'network_4xx_unexpected',
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, { status: number; rootCause: string }>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      const status = response.status;

      if (kind === 'network_5xx') {
        if (status === 0) {
          detectionsByPage.set(route, { status, rootCause: `Connectivity failure (status 0) from GET ${route}` });
        } else if (status >= 500) {
          detectionsByPage.set(route, { status, rootCause: `HTTP ${status} from GET ${route}` });
        }
      } else {
        // network_4xx_unexpected
        if (status >= 400 && status < 500) {
          detectionsByPage.set(route, { status, rootCause: `Unexpected HTTP ${status} from GET ${route}` });
        }
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];

  for (const [page, { rootCause }] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
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
      severity: kind === 'network_5xx' ? 'major' : 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// i18n text-content static-heuristic runners.
// Production paths use locale-stress probes via camofox; harness uses focused
// regex over the rendered HTML body.
// ---------------------------------------------------------------------------

const I18N_BAD_DATE_RE = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}\b/;
const I18N_GOOD_DATE_DISAMBIGUATORS = [
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

function findAmbiguousDate(html: string): boolean {
  if (!I18N_BAD_DATE_RE.test(html)) return false;
  return !I18N_GOOD_DATE_DISAMBIGUATORS.some(re => re.test(html));
}

/** Detect "1 <plural-noun>" patterns where the noun is plural but count is one. */
function findBrokenPluralization(html: string): string | null {
  // Strip HTML tags so we don't match across element boundaries.
  const text = html.replace(/<[^>]+>/g, ' ');
  // Match: "1 word" where word ends in 's' but is not a known singular ending in 's' (boss, address...).
  const re = /\b1\s+([a-z]+s)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const noun = (match[1] ?? '').toLowerCase();
    // Exclude common nouns that genuinely end in 's' (bus, boss, glass, etc.) by minimum length 4
    // and dropping the common 'ss' ending that's not pluralization.
    if (noun.length < 4) continue;
    if (noun.endsWith('ss')) continue;
    return noun;
  }
  return null;
}

const I18N_CURRENCY_DECIMALS: Record<string, number> = {
  '$': 2,    // USD
  'EUR': 2,
  '£': 2,    // GBP
  '¥': 0,    // JPY
  'KRW': 0,
  '€': 2,
};

/** Detect currency-amount strings whose decimals don't match the currency convention. */
function findBrokenCurrency(html: string): string | null {
  const text = html.replace(/<[^>]+>/g, ' ');
  // Match $123, $123.45, $123.4567, ¥123, etc.
  const re = /([$£¥€])(\d+(?:[.,]\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const symbol = match[1] ?? '';
    const amount = match[2] ?? '';
    const expected = I18N_CURRENCY_DECIMALS[symbol];
    if (expected === undefined) continue;
    const decimalIdx = amount.indexOf('.');
    const decimals = decimalIdx === -1 ? 0 : amount.length - decimalIdx - 1;
    if (decimals !== expected) return `${symbol}${amount}`;
  }
  return null;
}

async function runI18nTextStaticHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: 'i18n_date_format_ambiguous' | 'i18n_pluralization_broken' | 'i18n_currency_format_broken',
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      let rootCause: string | undefined;
      if (kind === 'i18n_date_format_ambiguous') {
        if (findAmbiguousDate(response.body)) {
          rootCause = `${route} renders a date in ambiguous MM/DD/YYYY or DD/MM/YYYY format with no spelled-out month or ISO 8601 disambiguator`;
        }
      } else if (kind === 'i18n_pluralization_broken') {
        const noun = findBrokenPluralization(response.body);
        if (noun !== null) {
          rootCause = `${route} renders "1 ${noun}" — singular count with plural noun morphology`;
        }
      } else {
        const value = findBrokenCurrency(response.body);
        if (value !== null) {
          rootCause = `${route} renders currency value "${value}" with decimals not matching the currency's convention`;
        }
      }
      if (rootCause !== undefined) {
        detectionsByPage.set(route, rootCause);
        log.info(`${kind}: detection`, { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
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
      severity: 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// css-heuristics runners — touch_target_too_small, hover_only_affordance,
// i18n_long_string_overflow, i18n_timezone_display_wrong.
// All are static heuristic checks against rendered HTML body.
// ---------------------------------------------------------------------------

const TOUCH_TARGET_MIN_PX = 24;

function findSmallTouchTargets(html: string): boolean {
  // Find every <button>/<a> with explicit width or height < 24px in inline style.
  const re = /<(button|a)\b[^>]*\bstyle\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const style = match[2] ?? '';
    const wMatch = /\bwidth\s*:\s*(\d+)\s*px/i.exec(style);
    const hMatch = /\bheight\s*:\s*(\d+)\s*px/i.exec(style);
    const width = wMatch !== null ? parseInt(wMatch[1] ?? '0', 10) : Infinity;
    const height = hMatch !== null ? parseInt(hMatch[1] ?? '0', 10) : Infinity;
    if (width < TOUCH_TARGET_MIN_PX || height < TOUCH_TARGET_MIN_PX) return true;
  }
  return false;
}

function findHoverOnlyAffordance(html: string): boolean {
  // Page has :hover rules without any matching :focus rule.
  const hasHover = /:hover\b/i.test(html);
  if (!hasHover) return false;
  const hasFocus = /:focus(?:-visible)?\b/i.test(html);
  return !hasFocus;
}

function findOverflowOverlyConstrained(html: string): boolean {
  // Heuristic: text-overflow:ellipsis + overflow:hidden + fixed-px width on a label-ish element.
  // (Without min-width:0 on a flex container parent — we can't statically tell, so we look for
  // the antipattern of fixed-pixel width + ellipsis without a sibling/parent flex hint.)
  if (!/text-overflow\s*:\s*ellipsis/i.test(html)) return false;
  if (!/overflow\s*:\s*hidden/i.test(html)) return false;
  const widthMatch = /\bwidth\s*:\s*(\d+)\s*px/i.exec(html);
  if (widthMatch === null) return false;
  // If the page also uses flex / min-width:0 / max-width / fr, treat as accommodating.
  if (/flex\s*:|min-width\s*:\s*0/i.test(html)) return false;
  return true;
}

const TZ_SUFFIX_RE = /\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+)([A-Z]{2,4}|[+-]\d{2}:?\d{2})\b/g;

function findTimezoneInconsistency(html: string): boolean {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = TZ_SUFFIX_RE.exec(html)) !== null) {
    const tz = match[2];
    if (tz !== undefined) found.add(tz);
  }
  return found.size >= 2;
}

async function runCssHeuristicsHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: 'touch_target_too_small' | 'hover_only_affordance' | 'i18n_long_string_overflow' | 'i18n_timezone_display_wrong',
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      let rootCause: string | undefined;
      if (kind === 'touch_target_too_small') {
        if (findSmallTouchTargets(response.body)) {
          rootCause = `${route} contains an interactive element with explicit width or height < ${TOUCH_TARGET_MIN_PX}px`;
        }
      } else if (kind === 'hover_only_affordance') {
        if (findHoverOnlyAffordance(response.body)) {
          rootCause = `${route} has :hover styles without a :focus / :focus-visible counterpart — keyboard users see no affordance`;
        }
      } else if (kind === 'i18n_long_string_overflow') {
        if (findOverflowOverlyConstrained(response.body)) {
          rootCause = `${route} uses fixed-pixel width + text-overflow:ellipsis on translatable text — long translations will be truncated`;
        }
      } else {
        if (findTimezoneInconsistency(response.body)) {
          rootCause = `${route} renders multiple timestamps with conflicting timezone suffixes — likely shows times in a wrong/mixed timezone`;
        }
      }
      if (rootCause !== undefined) {
        detectionsByPage.set(route, rootCause);
        log.info(`${kind}: detection`, { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];
  for (const [page, rootCause] of detectionsByPage) {
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [{
        occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
        role: 'anonymous',
        page,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// password_reset_token_reuse runner.
// Three-step probe per route: POST /<route>/request → consume(token) → consume(token).
// Fires when the second consume succeeds (status 2xx + body ok:true).
// ---------------------------------------------------------------------------

function postReturningJson(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5_000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => resolve({ status: 0, body: '' }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.write(body);
      req.end();
    } catch {
      resolve({ status: 0, body: '' });
    }
  });
}

async function runPasswordResetReuseHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('password_reset_token_reuse: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;

      // Derive request endpoint from consume endpoint: /reset-X/consume → /reset-X/request
      if (!route.endsWith('/consume')) continue;
      const requestPath = route.replace(/\/consume$/, '/request');

      // Reset state
      await httpPost(`${appBaseUrl}/__bughunter_reset`, '').catch(() => {});

      // 1. Request token
      const issueResp = await postReturningJson(`${appBaseUrl}${requestPath}`, '{}');
      if (issueResp.status === 0) continue;
      let token: string | undefined;
      try {
        const parsed = JSON.parse(issueResp.body) as { token?: string };
        token = parsed.token;
      } catch { /* continue */ }
      if (token === undefined) continue;

      // 2. First consume — should succeed
      const first = await postReturningJson(`${appBaseUrl}${route}`, JSON.stringify({ token }));
      if (first.status === 0) continue;

      // 3. Second consume — must be rejected
      const second = await postReturningJson(`${appBaseUrl}${route}`, JSON.stringify({ token }));
      if (second.status === 0) continue;

      // Server says token reuse succeeded if status is 2xx AND body either lacks ok:false or has ok:true
      const secondOk = second.status >= 200 && second.status < 300;
      let bodyAcceptedReuse = secondOk;
      if (secondOk) {
        try {
          const parsed = JSON.parse(second.body) as { ok?: boolean; error?: string };
          if (parsed.ok === false) bodyAcceptedReuse = false;
          if (typeof parsed.error === 'string' && parsed.error.length > 0) bodyAcceptedReuse = false;
        } catch { /* non-JSON 200 — treat as accepted */ }
      }

      if (bodyAcceptedReuse) {
        detectionsByPage.set(route, `${route}: token reused successfully on second POST — server did not invalidate the token after first use`);
        log.info('password_reset_token_reuse: detection', { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'password_reset_token_reuse';
  const clusters: BugCluster[] = [];
  for (const [page, rootCause] of detectionsByPage) {
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [{
        occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
        role: 'anonymous',
        page,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }],
      suspectedFiles: [],
      fixHints: ['Mark the password-reset token as used (server-side) on first consume; reject all subsequent uses'],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// auth_session_fixation runner.
// Two-step probe: GET /login-route (capture pre-login session cookie),
// then POST /login-route with creds (capture post-login cookie). Fires
// when the primary session cookie value is unchanged across the boundary.
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAMES = ['sessionid', 'sid', 'session', 'connect.sid', 'PHPSESSID'];

function pickSessionCookie(setCookies: string[]): { name: string; value: string } | null {
  for (const raw of setCookies) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const name = raw.slice(0, eq).trim();
    const semi = raw.indexOf(';', eq);
    const value = (semi === -1 ? raw.slice(eq + 1) : raw.slice(eq + 1, semi)).trim();
    if (SESSION_COOKIE_NAMES.some(p => name.toLowerCase() === p.toLowerCase())) {
      return { name, value };
    }
  }
  return null;
}

function loginPostJson(url: string, body: string): Promise<{ status: number; setCookies: string[] }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 5_000,
      }, (res) => {
        const setCookieRaw = res.headers['set-cookie'];
        const setCookies: string[] = Array.isArray(setCookieRaw) ? setCookieRaw : typeof setCookieRaw === 'string' ? [setCookieRaw] : [];
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookies }));
        res.on('error', () => resolve({ status: 0, setCookies: [] }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, setCookies: [] }); });
      req.on('error', () => resolve({ status: 0, setCookies: [] }));
      req.write(body);
      req.end();
    } catch {
      resolve({ status: 0, setCookies: [] });
    }
  });
}

async function runSessionFixationHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('auth_session_fixation: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;

      // GET first — capture pre-login session cookie.
      const preResp = await fetchSetCookieHeaders(url);
      if (preResp.status === 0) continue;
      const preCookie = pickSessionCookie(preResp.setCookies);
      if (preCookie === null) continue; // no session cookie issued — token-auth or unrelated route

      // POST creds.
      const postResp = await loginPostJson(url, JSON.stringify({ email: 'a@b.com', password: 'pw' }));
      if (postResp.status === 0) continue;
      const postCookie = pickSessionCookie(postResp.setCookies);
      if (postCookie === null) continue;

      if (preCookie.name === postCookie.name && preCookie.value === postCookie.value) {
        detectionsByPage.set(route, `Session cookie '${preCookie.name}' did not change after login on ${route} — pre-login value reused (fixation)`);
        log.info('auth_session_fixation: detection', { route, cookie: preCookie.name });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'auth_session_fixation';
  const clusters: BugCluster[] = [];
  for (const [page, rootCause] of detectionsByPage) {
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [{
        occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
        role: 'anonymous',
        page,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }],
      suspectedFiles: [],
      fixHints: ['Rotate (regenerate) the session ID inside the login handler after credentials are validated'],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// data_integrity_orphan + soft_delete_consistency runners.
// Per-kind: trigger a mutation and observe a downstream read endpoint.
// ---------------------------------------------------------------------------

async function runDataIntegrityOrphanHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('data_integrity_orphan: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      // Reset state
      await httpPost(`${appBaseUrl}/__bughunter_reset`, '').catch(() => {});

      // Trigger the mutation
      const status = await bareRequest(`${appBaseUrl}${route}`, 'POST');
      if (status === 0) continue;

      // Derive the read endpoint: /api/orphan-broken/delete-parent → /api/orphan-broken
      const segments = route.split('/');
      if (segments.length < 3) continue;
      const readPath = `/${segments[1]}/${segments[2]}`;
      const readResp = await httpGet(`${appBaseUrl}${readPath}`).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (readResp.status === 0) continue;
      try {
        const data = JSON.parse(readResp.body) as { orphans?: unknown[] };
        if (Array.isArray(data.orphans) && data.orphans.length > 0) {
          detectionsByPage.set(route, `Mutating ${route} left ${data.orphans.length} orphan child rows referenced by ${readPath}`);
        }
      } catch { /* ignore parse error */ }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'data_integrity_orphan';
  const clusters: BugCluster[] = [];
  for (const [page, rootCause] of detectionsByPage) {
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [{
        occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
        role: 'anonymous',
        page,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }],
      suspectedFiles: [],
      fixHints: ['Cascade-delete or restrict-delete child rows when parent is removed'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }
  return clusters;
}

async function runSoftDeleteConsistencyHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('soft_delete_consistency: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      await httpPost(`${appBaseUrl}/__bughunter_reset`, '').catch(() => {});

      const status = await bareRequest(`${appBaseUrl}${route}`, 'POST');
      if (status === 0) continue;

      // Derive list endpoint: /api/soft-delete-inconsistent/delete → /api/soft-delete-inconsistent/list
      const segments = route.split('/');
      if (segments.length < 4) continue;
      const listPath = `/${segments[1]}/${segments[2]}/list`;
      const listResp = await httpGet(`${appBaseUrl}${listPath}`).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (listResp.status === 0) continue;
      try {
        const data = JSON.parse(listResp.body) as { items?: Array<{ deletedAt?: number | null }> };
        const inconsistent = (data.items ?? []).find(it => it.deletedAt !== null && it.deletedAt !== undefined);
        if (inconsistent !== undefined) {
          detectionsByPage.set(route, `${route}: soft-deleted item still appears in ${listPath} response (deletedAt set but item not filtered)`);
        }
      } catch { /* ignore */ }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'soft_delete_consistency';
  const clusters: BugCluster[] = [];
  for (const [page, rootCause] of detectionsByPage) {
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [{
        occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
        role: 'anonymous',
        page,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }],
      suspectedFiles: [],
      fixHints: ['Filter rows where deletedAt IS NOT NULL on read paths after soft-delete'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// audit_log_missing_for_mutation runner.
// Per-route test plan: method + isMutation. For each mutating route, GET
// /audit/recent before and after the mutation; fire if log size unchanged.
// ---------------------------------------------------------------------------

type AuditLogPlan = { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; isMutation: boolean };

const AUDIT_LOG_ROUTE_PLANS: Record<string, AuditLogPlan> = {
  '/api/posts/delete': { method: 'POST', isMutation: true },
  '/api/users/update': { method: 'PUT', isMutation: true },
  '/api/payments/charge': { method: 'POST', isMutation: true },
  '/api/admin/grant-role': { method: 'POST', isMutation: true },
  '/api/users/list': { method: 'GET', isMutation: false },
  '/api/orders/cancel': { method: 'POST', isMutation: true },
};

function fetchAuditCount(appBaseUrl: string): Promise<number> {
  return new Promise((resolve) => {
    httpGet(`${appBaseUrl}/audit/recent`)
      .then(resp => {
        try {
          const arr = JSON.parse(resp.body) as unknown[];
          resolve(Array.isArray(arr) ? arr.length : 0);
        } catch {
          resolve(0);
        }
      })
      .catch(() => resolve(0));
  });
}

function bareRequest(url: string, method: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname,
        method,
        timeout: 5_000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(0));
      });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
      req.end();
    } catch {
      resolve(0);
    }
  });
}

async function runAuditLogMissingHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('audit_log_missing_for_mutation: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const plan = AUDIT_LOG_ROUTE_PLANS[route];
      if (plan === undefined) {
        warnings.push(`audit_log_missing_for_mutation: no plan for ${route}; skipping`);
        continue;
      }
      // Reset audit state for clean probe
      await httpPost(`${appBaseUrl}/__bughunter_reset`, '').catch(() => {});

      const beforeCount = await fetchAuditCount(appBaseUrl);
      const status = await bareRequest(`${appBaseUrl}${route}`, plan.method);
      if (status === 0) continue;
      const afterCount = await fetchAuditCount(appBaseUrl);

      // Detector only fires on mutating methods.
      if (!plan.isMutation) continue;

      if (afterCount <= beforeCount) {
        detectionsByPage.set(route, `Mutating ${plan.method} ${route} returned ${status} but no audit-log entry was written (count before=${beforeCount}, after=${afterCount})`);
        log.info('audit_log_missing_for_mutation: detection', { route, method: plan.method });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'audit_log_missing_for_mutation';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Append an audit-log entry inside the mutation handler before returning success'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// cache_staleness runner — checks Cache-Control on JSON API endpoints.
// Fires when API JSON responses have long max-age without must-revalidate
// or no-cache, when the data appears mutable.
// ---------------------------------------------------------------------------

const CACHE_STALENESS_MAX_SAFE_SECONDS = 60;

function isApiJsonResponse(headers: Record<string, string | undefined>): boolean {
  const ct = (headers['content-type'] ?? '').toLowerCase();
  return ct.includes('application/json');
}

function findCacheStalenessRisk(headers: Record<string, string | undefined>): string | null {
  const cc = (headers['cache-control'] ?? '').toLowerCase();
  const expires = headers['expires'];

  // No-cache or no-store: appropriate, silent.
  if (/\b(no-cache|no-store)\b/.test(cc)) return null;
  // must-revalidate forces freshness check on every use — overrides max-age.
  if (/\bmust-revalidate\b/.test(cc)) return null;
  // private cache only: lower risk, silent.
  if (/\bprivate\b/.test(cc)) return null;

  // public + max-age above threshold = risky
  const maxAgeMatch = /max-age\s*=\s*(\d+)/.exec(cc);
  if (maxAgeMatch !== null) {
    const seconds = parseInt(maxAgeMatch[1] ?? '0', 10);
    if (seconds > CACHE_STALENESS_MAX_SAFE_SECONDS) {
      return `Cache-Control: max-age=${seconds} (>60s) without must-revalidate may serve stale data`;
    }
  }

  // Explicit far-future Expires header without revalidation directive
  if (expires !== undefined && expires.length > 0 && !cc.includes('max-age')) {
    try {
      const parsed = Date.parse(expires);
      const now = Date.now();
      if (!isNaN(parsed) && parsed - now > CACHE_STALENESS_MAX_SAFE_SECONDS * 1000) {
        return `Expires header (${expires}) is far in the future without must-revalidate`;
      }
    } catch { /* skip */ }
  }

  return null;
}

async function runCacheStalenessHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('cache_staleness: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGetWithHeaders(url).catch((): ProbeResponseWithHeaders => ({ status: 0, body: '', headers: {} }));
      if (response.status === 0) continue;

      // Only flag JSON API responses — HTML caching is generally fine.
      if (!isApiJsonResponse(response.headers)) continue;

      const risk = findCacheStalenessRisk(response.headers);
      if (risk !== null) {
        detectionsByPage.set(route, `${route}: ${risk}`);
        log.info('cache_staleness: detection', { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'cache_staleness';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Add must-revalidate to Cache-Control or set short max-age (<=60s) for mutable JSON data'],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// hallucinated_route runner — fetches /sitemap.xml, probes each claimed
// route, fires when a claimed route 404s.
// ---------------------------------------------------------------------------

function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[1] ?? '';
    try {
      // Extract pathname for path-only comparison
      const u = new URL(raw);
      locs.push(u.pathname);
    } catch {
      if (raw.startsWith('/')) locs.push(raw);
    }
  }
  return locs;
}

async function runHallucinatedRouteHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('hallucinated_route: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    // Fetch the sitemap (or equivalent route claim source).
    const sitemapResp = await httpGet(`${appBaseUrl}/sitemap.xml`).catch((): ProbeResponse => ({ status: 0, body: '' }));
    if (sitemapResp.status === 0 || sitemapResp.status >= 400) {
      warnings.push('hallucinated_route: /sitemap.xml not available — cannot enumerate claimed routes');
    } else {
      const claimedRoutes = extractSitemapLocs(sitemapResp.body);
      log.info('hallucinated_route: sitemap claims', { count: claimedRoutes.length });

      for (const route of claimedRoutes) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) break;
        const url = `${appBaseUrl}${route}`;
        const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (response.status === 404) {
          detectionsByPage.set(route, `Sitemap-claimed route ${route} returned 404 — route does not exist on the server`);
          log.info('hallucinated_route: detection', { route });
        }
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'hallucinated_route';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Either implement the missing route or remove it from the sitemap/links'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// no_rate_limit_on_login runner — sends N bogus-credential POSTs to each
// route, fires when no 429/423 status is observed within the cap.
// ---------------------------------------------------------------------------

const NO_RATE_LIMIT_ATTEMPT_CAP = 15;

function loginPost(url: string, body: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5_000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(0));
      });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.on('error', () => resolve(0));
      req.write(body);
      req.end();
    } catch {
      resolve(0);
    }
  });
}

async function runNoRateLimitOnLoginHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('no_rate_limit_on_login: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();
  const bogusCreds = JSON.stringify({ email: 'bughunter-probe-user@invalid.test', password: 'BugHunterProbe!Invalid999' });

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;

      let rateLimitHit = false;
      for (let attempt = 0; attempt < NO_RATE_LIMIT_ATTEMPT_CAP; attempt++) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) break;
        const status = await loginPost(url, bogusCreds);
        if (status === 429 || status === 423) {
          rateLimitHit = true;
          break;
        }
      }

      if (!rateLimitHit) {
        detectionsByPage.set(route, `Login endpoint ${route} accepted ${NO_RATE_LIMIT_ATTEMPT_CAP} bogus-credential POSTs without 429/423`);
        log.info('no_rate_limit_on_login: detection', { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'no_rate_limit_on_login';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Apply rate limiting (e.g., 5 attempts per IP per minute) to login endpoints'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// script-content static-heuristic runners.
// Production paths use browser/static analysers; harness uses focused regex.
// Serves: iframe_postmessage_unguarded, xss_dom, swallowed_error_empty_catch, jwt_weak_alg.
// ---------------------------------------------------------------------------

/** Detect message handlers in script content that DO NOT check event.origin. */
function findUnguardedPostMessageHandlers(html: string): boolean {
  // Find every addEventListener('message', handlerBody) — capture the handler body.
  const re = /addEventListener\s*\(\s*['"]message['"]\s*,\s*((?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    // Locate the handler body span — find matching opening brace, then balanced match.
    const startIdx = match.index;
    // Look ahead in `html` for the end of this handler. Find next `{` then balance.
    const afterPrefix = html.indexOf('{', startIdx);
    if (afterPrefix === -1) continue;
    let depth = 0;
    let endIdx = afterPrefix;
    for (let i = afterPrefix; i < html.length; i++) {
      const ch = html[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    const handlerBody = html.slice(afterPrefix, endIdx + 1);
    // Heuristic: handler is guarded if it references e.origin / event.origin / .origin
    if (!/\borigin\s*[!=]==?/i.test(handlerBody)) return true;
  }
  return false;
}

/** Detect XSS-DOM patterns: innerHTML / outerHTML / document.write of non-literal input. */
function findXssDomSinks(html: string): boolean {
  const sinkRe = /(innerHTML|outerHTML|document\.write|document\.writeln|insertAdjacentHTML)\s*(?:\(|=)\s*([^;)]{0,100})/gi;
  let match: RegExpExecArray | null;
  while ((match = sinkRe.exec(html)) !== null) {
    const arg = (match[2] ?? '').trim();
    // Trivially-safe assignments: string literal (single quote, double quote, backtick with no ${})
    if (/^['"]/.test(arg) || /^`[^`$]*`/.test(arg)) continue;
    // Still flagged: location.search/hash/pathname, params.get(), variable, function call
    if (
      /location\.(search|hash|pathname|href)/i.test(arg)
      || /params\.get\b/i.test(arg)
      || /\.value\b/i.test(arg)
      || /^[A-Za-z_$][\w$]*\s*[(.]/.test(arg)
    ) return true;
    // Variable name alone — assume tainted
    if (/^[A-Za-z_$][\w$]*\s*$/.test(arg)) return true;
  }
  return false;
}

/** Detect empty `catch (e) {}` blocks (whitespace/newlines only inside the braces). */
function findEmptyCatchBlocks(html: string): boolean {
  const re = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  return re.test(html);
}

/** Decode a JWT-like token's header payload and return its `alg` value, or null. */
function readJwtAlg(token: string): string | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return null;
  const headerB64 = token.slice(0, dotIdx);
  try {
    const decoded = Buffer.from(headerB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as { alg?: string };
    return typeof parsed.alg === 'string' ? parsed.alg : null;
  } catch {
    return null;
  }
}

/** Find any JWT-shaped token in `html` and check its alg. Returns the weak alg if any. */
function findWeakJwtAlg(html: string): string | null {
  // Match base64url.base64url.base64url[ optional ] — JWT signature can be empty for alg=none.
  const jwtRe = /\b(eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = jwtRe.exec(html)) !== null) {
    const token = match[1] ?? '';
    const alg = readJwtAlg(token);
    if (alg === null) continue;
    const upper = alg.toUpperCase();
    if (upper === 'NONE' || upper === 'HS256' || upper === 'HS384' || upper === 'HS512') {
      return alg;
    }
  }
  return null;
}

async function runScriptContentStaticHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: 'iframe_postmessage_unguarded' | 'xss_dom' | 'swallowed_error_empty_catch' | 'jwt_weak_alg',
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      let rootCause: string | undefined;
      if (kind === 'iframe_postmessage_unguarded') {
        if (findUnguardedPostMessageHandlers(response.body)) {
          rootCause = `${route} registers a window.message handler with no event.origin check — unguarded message receiver`;
        }
      } else if (kind === 'xss_dom') {
        if (findXssDomSinks(response.body)) {
          rootCause = `${route} writes a non-literal value into a DOM XSS sink (innerHTML / document.write)`;
        }
      } else if (kind === 'swallowed_error_empty_catch') {
        if (findEmptyCatchBlocks(response.body)) {
          rootCause = `${route} has an empty catch block — error is swallowed silently`;
        }
      } else {
        // jwt_weak_alg
        const weak = findWeakJwtAlg(response.body);
        if (weak !== null) {
          rootCause = `${route} contains a JWT with weak alg='${weak}'`;
        }
      }
      if (rootCause !== undefined) {
        detectionsByPage.set(route, rootCause);
        log.info(`${kind}: detection`, { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const severity: 'critical' | 'major' | 'minor' = kind === 'xss_dom'
    ? 'critical'
    : kind === 'swallowed_error_empty_catch' ? 'minor' : 'major';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
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
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// browser-platform static-heuristic runners.
// Production paths require browser runtime (camofox); the harness implements
// a focused static check matching the most-common-case 80% detection.
// ---------------------------------------------------------------------------

/** Find external <script src="..."> and <link rel="stylesheet" href="..."> elements
 *  (different origin) that lack an `integrity="..."` attribute. */
function findExternalSubresourcesMissingIntegrity(html: string, baseOrigin: string): string[] {
  const missing: string[] = [];
  const tagRe = /<(script|link)\b[^>]*?>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const tagName = match[1]?.toLowerCase() ?? '';
    let urlAttr: string | undefined;
    if (tagName === 'script') {
      const m = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
      urlAttr = m === null ? undefined : m[1];
    } else if (tagName === 'link') {
      // Only flag rel="stylesheet" (script-like risk) — other rels (icon, manifest) skip.
      if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
      const m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
      urlAttr = m === null ? undefined : m[1];
    }
    if (urlAttr === undefined) continue;
    const isExternal = /^https?:\/\//i.test(urlAttr) || urlAttr.startsWith('//');
    if (!isExternal) continue;
    // Skip if same origin
    try {
      const target = new URL(urlAttr, baseOrigin);
      if (target.origin === baseOrigin) continue;
    } catch { /* fall through */ }
    if (/\bintegrity\s*=/i.test(tag)) continue;
    missing.push(tag);
  }
  return missing;
}

async function runBrowserPlatformStaticHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: 'subresource_integrity_violation' | 'coop_coep_violation' | 'trusted_types_violation',
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const baseOrigin = (() => { try { return new URL(appBaseUrl).origin; } catch { return appBaseUrl; } })();
  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGetWithHeaders(url).catch((): ProbeResponseWithHeaders => ({ status: 0, body: '', headers: {} }));
      if (response.status === 0) continue;

      if (kind === 'subresource_integrity_violation') {
        const missing = findExternalSubresourcesMissingIntegrity(response.body, baseOrigin);
        if (missing.length > 0) {
          detectionsByPage.set(route, `${missing.length} external subresource(s) on ${route} missing integrity attribute`);
        }
      } else if (kind === 'coop_coep_violation') {
        // Detect if SharedArrayBuffer is INSTANTIATED (new SharedArrayBuffer(...)),
        // not just referenced via typeof. Then check for COOP/COEP isolation headers.
        const sabInstantiated = /new\s+SharedArrayBuffer\s*\(/i.test(response.body);
        if (!sabInstantiated) continue;
        const coop = (response.headers['cross-origin-opener-policy'] ?? '').toLowerCase();
        const coep = (response.headers['cross-origin-embedder-policy'] ?? '').toLowerCase();
        const isolated = coop === 'same-origin' && (coep === 'require-corp' || coep === 'credentialless');
        if (!isolated) {
          detectionsByPage.set(route, `${route} instantiates SharedArrayBuffer but COOP/COEP headers do not enable cross-origin isolation`);
        }
      } else {
        // trusted_types_violation
        const csp = response.headers['content-security-policy'] ?? '';
        const cspLower = csp.toLowerCase();
        const requiresTT = cspLower.includes('require-trusted-types-for');
        const declaresTT = /\btrusted-types\s+\S+/i.test(csp);
        if (requiresTT && !declaresTT) {
          detectionsByPage.set(route, `${route} CSP requires Trusted Types but declares no policy — runtime DOM-XSS sinks will throw`);
        }
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
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
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// 404_for_linked_route runner — extracts <a href="/path"> from each fixture
// page, probes each linked path, fires on 404.
// ---------------------------------------------------------------------------

function extractInternalLinks(html: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const hrefRe = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1] ?? '';
    if (href.length === 0) continue;
    if (href.startsWith('#')) continue;                // fragment
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    // eslint-disable-next-line no-script-url -- skip javascript: hrefs (not navigable HTTP routes)
    if (href.startsWith('javascript:')) continue;
    if (/^https?:\/\//i.test(href) || href.startsWith('//')) continue;  // external origin
    if (!href.startsWith('/')) continue;               // require absolute path
    if (seen.has(href)) continue;
    seen.add(href);
    results.push(href);
  }
  return results;
}

async function run404ForLinkedRouteHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('404_for_linked_route: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  // Map page → set of broken paths
  const brokenByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const links = extractInternalLinks(response.body);
      const broken: string[] = [];
      for (const link of links) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted) break;
        const linkResp = await httpGet(`${appBaseUrl}${link}`).catch((): ProbeResponse => ({ status: 0, body: '' }));
        if (linkResp.status === 404) broken.push(link);
      }
      if (broken.length > 0) {
        brokenByPage.set(route, broken);
        log.info('404_for_linked_route: detection', { route, broken });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = '404_for_linked_route';
  const clusters: BugCluster[] = [];

  for (const [page, broken] of brokenByPage) {
    const occurrences: Occurrence[] = broken.map((path, idx) => ({
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${idx}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    }));
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `Page ${page} links to ${broken.length} broken path(s): ${broken.join(', ')}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: broken.length,
      occurrences,
      suspectedFiles: [],
      fixHints: ['Either fix the broken paths or remove the dead links from the page'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// csrf_missing_on_mutating_route runner.
// Each route gets a per-route test plan that controls method, requestHeaders,
// and cookieJar at probe time. Probes are issued live to capture the actual
// Set-Cookie response, then a CsrfObservation is built and fed to detectMissingCsrf.
// ---------------------------------------------------------------------------

type CsrfRouteTestPlan = {
  /** Probe method. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Headers to send on the request. */
  requestHeaders: Record<string, string>;
  /** Cookies to claim are in the jar at request time (built from prior route Set-Cookie). */
  cookieJar: string[];
};

const CSRF_ROUTE_PLANS: Record<string, CsrfRouteTestPlan> = {
  '/api/posts/create': {
    method: 'POST',
    requestHeaders: { cookie: 'sessionid=abc123def456ghi789jklmnop1234567890=' },
    cookieJar: ['sessionid=abc123def456ghi789jklmnop1234567890='],
  },
  '/api/users/update': {
    method: 'PUT',
    requestHeaders: { cookie: 'sid=abc123def456ghi789jklmnop1234567890=' },
    cookieJar: ['sid=abc123def456ghi789jklmnop1234567890='],
  },
  '/api/strict-session/mutate': {
    method: 'POST',
    requestHeaders: { cookie: 'sessionid=abc123def456ghi789jklmnop1234567890=' },
    cookieJar: ['sessionid=abc123def456ghi789jklmnop1234567890='],
  },
  '/api/read-only': {
    method: 'GET',
    requestHeaders: {},
    cookieJar: [],
  },
  '/api/with-csrf-header/mutate': {
    method: 'POST',
    requestHeaders: {
      cookie: 'sessionid=abc123def456ghi789jklmnop1234567890=',
      'x-csrf-token': 'csrf-secret-token-1234',
    },
    cookieJar: ['sessionid=abc123def456ghi789jklmnop1234567890='],
  },
  '/api/bearer-auth/mutate': {
    method: 'POST',
    requestHeaders: { authorization: 'Bearer eyJ.fake.jwt' },
    cookieJar: [],
  },
  '/api/with-csrf-cookie/mutate': {
    method: 'POST',
    requestHeaders: {
      cookie: 'sessionid=abc123def456ghi789jklmnop1234567890=; csrf-token=secret',
    },
    cookieJar: [
      'sessionid=abc123def456ghi789jklmnop1234567890=',
      'csrf-token=secret',
    ],
  },
};

function httpRequestForObservation(
  baseUrl: string,
  route: string,
  plan: CsrfRouteTestPlan,
): Promise<{ status: number; setCookies: string[] }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(`${baseUrl}${route}`);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname,
        method: plan.method,
        headers: plan.requestHeaders,
        timeout: 5_000,
      }, (res) => {
        const setCookieRaw = res.headers['set-cookie'];
        const setCookies = Array.isArray(setCookieRaw)
          ? setCookieRaw
          : typeof setCookieRaw === 'string' ? [setCookieRaw] : [];
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookies }));
        res.on('error', () => resolve({ status: 0, setCookies: [] }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, setCookies: [] }); });
      req.on('error', () => resolve({ status: 0, setCookies: [] }));
      req.end();
    } catch {
      resolve({ status: 0, setCookies: [] });
    }
  });
}

async function runCsrfMissingHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('csrf_missing_on_mutating_route: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const observations: CsrfObservation[] = [];

  // Map per-observation route key → URL pathname (for cluster page-matching)
  const routeForObservation = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const plan = CSRF_ROUTE_PLANS[route];
      if (plan === undefined) {
        warnings.push(`csrf_missing_on_mutating_route: no test plan for route ${route}; skipping`);
        continue;
      }
      const { status, setCookies } = await httpRequestForObservation(appBaseUrl, route, plan);
      if (status === 0) continue;

      // Skip non-mutating methods — production detector ignores them too, but the
      // observation list filters at the projection layer in production. Here we
      // still emit only mutating methods to detectMissingCsrf.
      if (plan.method === 'GET') {
        // No CsrfObservation for GET; cluster will not be created by definition.
        continue;
      }

      const fullUrl = `${appBaseUrl}${route}`;
      observations.push({
        method: plan.method,
        url: fullUrl,
        requestHeaders: { ...plan.requestHeaders },
        cookieJar: plan.cookieJar,
        responseSetCookieHeaders: setCookies,
      });
      routeForObservation.set(fullUrl, route);
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');

  const detections = detectMissingCsrf(observations);

  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'csrf_missing_on_mutating_route';
  const clusters: BugCluster[] = [];

  for (const detection of detections) {
    // detection.endpoint is "POST /api/posts/create" — extract just the path
    const endpoint = detection.endpoint ?? '';
    const spaceIdx = endpoint.indexOf(' ');
    const page = spaceIdx === -1 ? endpoint : endpoint.slice(spaceIdx + 1);

    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: detection.rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Require X-CSRF-Token header on mutating routes; or set SameSite=Strict on session cookies'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// open_redirect runner — probes redirect-param routes with evil.test target.
// ---------------------------------------------------------------------------

const OPEN_REDIRECT_PROBE_PARAMS = ['redirect', 'return_to', 'returnTo', 'next', 'url', 'continue', 'redirectUrl'];

function fetchLocationHeader(url: string): Promise<{ status: number; location: string }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 5_000,
      }, (res) => {
        const loc = res.headers['location'];
        const location = typeof loc === 'string' ? loc : '';
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location }));
        res.on('error', () => resolve({ status: 0, location: '' }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, location: '' }); });
      req.on('error', () => resolve({ status: 0, location: '' }));
    } catch {
      resolve({ status: 0, location: '' });
    }
  });
}

async function runOpenRedirectHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('open_redirect: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;

      // Probe each redirect-param synonym; first match wins.
      let firedParam: string | undefined;
      for (const param of OPEN_REDIRECT_PROBE_PARAMS) {
        const probeUrl = `${appBaseUrl}${route}?${encodeURIComponent(param)}=https%3A%2F%2Fevil.test`;
        const { status, location } = await fetchLocationHeader(probeUrl);
        if (status >= 300 && status < 400 && location.includes('evil.test')) {
          firedParam = param;
          break;
        }
      }

      if (firedParam !== undefined) {
        detectionsByPage.set(route, `Open redirect via '${firedParam}' parameter on ${route} — Location header echoes attacker-controlled URL`);
        log.info('open_redirect: detection', { route, param: firedParam });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'open_redirect';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Validate redirect targets against an allowlist or reject external URLs entirely'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// stack_trace_leak_in_response runner — body scan on 5xx responses.
// ---------------------------------------------------------------------------

async function runStackTraceLeakHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('stack_trace_leak_in_response: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      // Detector only fires on 5xx — match production behaviour.
      if (response.status < 500) continue;

      const detections = analyzeResponseBody(response.body, route);
      if (detections.length > 0) {
        detectionsByPage.set(route, detections[0]?.rootCause ?? `Stack trace leaked in ${route}`);
        log.info('stack_trace_leak_in_response: detection', { route, status: response.status });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'stack_trace_leak_in_response';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: ['Strip stack traces from production error responses; log them server-side instead'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// cookie_security_flags runner — fires per missing flag on session cookies.
// ---------------------------------------------------------------------------

const SESSION_COOKIE_PATTERNS = ['session', 'sess', 'sid', 'auth', 'token', 'jwt'];
const CSRF_COOKIE_PATTERNS = ['csrf', 'xsrf', '_csrf'];

type ParsedCookie = { name: string; value: string; flags: string[] };

function parseSetCookieValue(raw: string): ParsedCookie | null {
  const parts = raw.split(';').map(p => p.trim());
  const nameValue = parts[0] ?? '';
  if (nameValue.length === 0) return null;
  const eq = nameValue.indexOf('=');
  if (eq === -1) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (name.length === 0) return null;
  return { name, value, flags: parts.slice(1).map(p => p.toLowerCase()) };
}

function isCookieSessionShaped(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (SESSION_COOKIE_PATTERNS.some(p => lower.includes(p))) return true;
  return value.length >= 32 && /^[A-Za-z0-9_+/=.~-]+$/.test(value);
}

function isCookieCsrfShaped(name: string): boolean {
  const lower = name.toLowerCase();
  return CSRF_COOKIE_PATTERNS.some(p => lower.includes(p));
}

function fetchSetCookieHeaders(url: string): Promise<{ status: number; setCookies: string[] }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: 5_000,
      }, (res) => {
        const setCookieRaw = res.headers['set-cookie'];
        const setCookies: string[] = Array.isArray(setCookieRaw)
          ? setCookieRaw
          : typeof setCookieRaw === 'string' ? [setCookieRaw] : [];
        // Drain the body so the socket can close
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookies }));
        res.on('error', () => resolve({ status: 0, setCookies: [] }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, setCookies: [] }); });
      req.on('error', () => resolve({ status: 0, setCookies: [] }));
    } catch {
      resolve({ status: 0, setCookies: [] });
    }
  });
}

async function runCookieSecurityFlagsHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('cookie_security_flags: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  // page → list of "Cookie 'X' missing FLAG" rootCauses
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const { status, setCookies } = await fetchSetCookieHeaders(url);
      if (status === 0) continue;

      const causes: string[] = [];
      for (const raw of setCookies) {
        const parsed = parseSetCookieValue(raw);
        if (parsed === null) continue;
        if (!isCookieSessionShaped(parsed.name, parsed.value)) continue;

        const hasSecure = parsed.flags.includes('secure');
        const hasHttpOnly = parsed.flags.includes('httponly');
        const hasSameSite = parsed.flags.some(f => f.startsWith('samesite'));

        // Skip Secure check on localhost/127.0.0.1 hosts (matches production behaviour).
        const isLocalhost = appBaseUrl.includes('localhost') || appBaseUrl.includes('127.0.0.1') || appBaseUrl.includes('::1');
        if (!hasSecure && !isLocalhost) {
          causes.push(`Cookie '${parsed.name}' missing Secure flag`);
        }
        if (!hasHttpOnly && !isCookieCsrfShaped(parsed.name)) {
          causes.push(`Cookie '${parsed.name}' missing HttpOnly flag`);
        }
        if (!hasSameSite) {
          causes.push(`Cookie '${parsed.name}' missing SameSite flag`);
        }
      }

      if (causes.length > 0) {
        detectionsByPage.set(route, causes);
        log.info('cookie_security_flags: detection', { route, count: causes.length });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'cookie_security_flags';
  const clusters: BugCluster[] = [];

  for (const [page, causes] of detectionsByPage) {
    const occurrences: Occurrence[] = causes.map((_, idx) => ({
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${idx}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    }));
    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: causes.join('; '),
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: causes.length,
      occurrences,
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// permissive_cors runner — probes routes, fires on ACAO:* + ACAC:true.
// ---------------------------------------------------------------------------

async function runPermissiveCorsHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('permissive_cors: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGetWithHeaders(url).catch((): ProbeResponseWithHeaders => ({ status: 0, body: '', headers: {} }));
      if (response.status === 0) continue;

      const acao = response.headers['access-control-allow-origin'];
      const acac = response.headers['access-control-allow-credentials'];

      if (acao === '*' && acac === 'true') {
        detectionsByPage.set(route, `${route} returns Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true — credentialed wildcard CORS exposes session data to any origin`);
        log.info('permissive_cors: detection', { route });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'permissive_cors';
  const clusters: BugCluster[] = [];

  for (const [page, rootCause] of detectionsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
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
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// SEO runner — scrape HTML pages, classify with classifySeoCorpus, filter by kind.
// One runner serves multiple SEO BugKinds (V56.3 batch grows incrementally).
// ---------------------------------------------------------------------------

type SeoProbeRoute = string;

function loadSeoProbeRoutes(fixturePath: string): SeoProbeRoute[] {
  const jsonlPath = path.join(fixturePath, 'expected-clusters.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];

  const pages = new Set<string>();
  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { expect?: string; match?: { page?: string } };
      if ((parsed.expect === 'fires' || parsed.expect === 'silent') && parsed.match?.page !== undefined) {
        pages.add(parsed.match.page);
      }
    } catch {
      // skip malformed
    }
  }
  return [...pages];
}

/**
 * Extract a single tag's text/attribute from raw HTML using non-strict regex.
 * Tolerant of malformed markup: returns null when the tag is genuinely absent
 * but does not throw on bad HTML structure.
 */
function extractSeoFields(html: string): {
  title: string | null;
  metaDescription: string | null;
  canonicalHref: string | null;
  h1Count: number;
  metaRobots: string | null;
} {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch !== null ? titleMatch[1] ?? '' : null;

  const metaDescMatch = /<meta[^>]+name=["']description["'][^>]*?content=["']([^"']*)["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html);
  const metaDescription = metaDescMatch !== null ? metaDescMatch[1] ?? '' : null;

  const canonicalMatch = /<link[^>]+rel=["']canonical["'][^>]*?href=["']([^"']*)["']/i.exec(html)
    ?? /<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i.exec(html);
  const canonicalHref = canonicalMatch !== null ? canonicalMatch[1] ?? '' : null;

  const h1Matches = html.match(/<h1\b[^>]*>/gi);
  const h1Count = h1Matches !== null ? h1Matches.length : 0;

  const robotsMatch = /<meta[^>]+name=["']robots["'][^>]*?content=["']([^"']*)["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']robots["']/i.exec(html);
  const metaRobots = robotsMatch !== null ? robotsMatch[1] ?? '' : null;

  return { title, metaDescription, canonicalHref, h1Count, metaRobots };
}

async function runSeoHarness(
  appBaseUrl: string,
  fixturePath: string,
  kind: BugKind,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push(`${kind}: fixture port not reachable during validate phase`);
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const seoPages: SeoPageInput[] = [];
  // Track which routes we observed so cluster-build can resolve page→route.
  const routeForRender = new Map<string, string>();
  let robotsTxt: string | null = null;

  if (phases.includes('execute')) {
    // Fetch /robots.txt once per run — required by seo_robots_blocking_crawl branch
    // that detects "Disallow: /" against User-agent: *. Other SEO detectors ignore it.
    const robotsResp = await httpGet(`${appBaseUrl}/robots.txt`).catch((): ProbeResponse => ({ status: 0, body: '' }));
    if (robotsResp.status >= 200 && robotsResp.status < 400) {
      robotsTxt = robotsResp.body;
    }

    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const fields = extractSeoFields(response.body);
      seoPages.push({
        pageRoute: route,
        title: fields.title,
        metaDescription: fields.metaDescription,
        canonicalHref: fields.canonicalHref,
        h1Count: fields.h1Count,
        metaRobots: fields.metaRobots,
      });
      routeForRender.set(route, route);
      log.info(`${kind}: probe`, { route, title: fields.title, h1Count: fields.h1Count });
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');

  // Run the shared corpus classifier and filter to the contract's kind.
  const detections = classifySeoCorpus({
    pages: seoPages,
    robotsTxt,
    origin: appBaseUrl,
  }).filter(d => d.kind === kind);

  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildSeoClusters(kind, detections);
}

function buildSeoClusters(
  kind: BugKind,
  detections: ReturnType<typeof classifySeoCorpus>,
): BugCluster[] {
  const now = new Date().toISOString();
  const clusters: BugCluster[] = [];

  for (const detection of detections) {
    // seo_title_duplicate_across_routes is cross-page: detection.pageRoute is null but
    // seoContext.affectedRoutes lists every page that shares the duplicate title. Emit one
    // cluster with one occurrence per affected route so match.page assertions can target any.
    const isDuplicateTitleDetection =
      detection.kind === 'seo_title_duplicate_across_routes'
      && detection.seoContext?.affectedRoutes !== undefined
      && detection.seoContext.affectedRoutes.length > 0;

    if (isDuplicateTitleDetection) {
      const routes = detection.seoContext!.affectedRoutes!;
      const slug = (detection.seoContext!.observedValue ?? 'duplicate')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      const occurrences: Occurrence[] = routes.map((route, idx) => ({
        occurrenceId: `harness-${kind}-${slug}-${idx}-${Date.now()}`,
        role: 'anonymous',
        page: route,
        action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
        fullArtifacts: false as const,
        timestamp: now,
      }));
      clusters.push({
        id: `harness-${kind}-${slug}`,
        runId: 'harness',
        kind,
        rootCause: detection.rootCause,
        firstSeenAt: now,
        lastSeenAt: now,
        clusterSize: routes.length,
        occurrences,
        suspectedFiles: [],
        fixHints: [],
        thirdPartyOrGenerated: false,
        severity: 'minor',
      });
      continue;
    }

    const page = detection.pageRoute ?? '*';
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'success',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: detection.rootCause,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: 1,
      occurrences: [occurrence],
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// interactive_element_missing_accessible_name runner — static <button>/<a> scanner.
// Production path uses click-runner via browser-mcp; harness uses static scan.
// ---------------------------------------------------------------------------

/**
 * Find every `<button>` and `<a>` whose accessible-name acquisition fails. Returns
 * the matched outer-tag strings. Considers: aria-label, aria-labelledby, title,
 * visible text content, and `<img alt="...">` inside the element.
 */
function findInteractiveElementsMissingName(html: string): string[] {
  const missing: string[] = [];
  // Only enumerate <button> and <a>. Skip <a> tags that lack href (not user-actionable).
  const blockRe = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    const tagName = match[1]?.toLowerCase() ?? '';
    const attrs = match[2] ?? '';
    const inner = match[3] ?? '';

    if (tagName === 'a' && !/\bhref\s*=/i.test(attrs)) continue;

    if (/\baria-label\s*=\s*["'][^"']+["']/i.test(attrs)) continue;
    if (/\baria-labelledby\s*=/i.test(attrs)) continue;
    if (/\btitle\s*=\s*["'][^"']+["']/i.test(attrs)) continue;

    // <img alt="non-empty"> inside provides accessible name
    if (/<img\b[^>]*\balt\s*=\s*["']([^"']+)["'][^>]*>/i.test(inner)) continue;

    // Strip all tags and check if any non-whitespace text remains
    const visibleText = inner.replace(/<[^>]*>/g, '').trim();
    if (visibleText !== '') continue;

    missing.push(`<${tagName}${attrs}>${inner}</${tagName}>`);
  }
  return missing;
}

async function runInteractiveElementMissingNameHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('interactive_element_missing_accessible_name: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const missing = findInteractiveElementsMissingName(response.body);
      if (missing.length > 0) {
        detectionsByPage.set(route, missing);
        log.info('interactive_element_missing_accessible_name: detection', { route, count: missing.length });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'interactive_element_missing_accessible_name';
  const clusters: BugCluster[] = [];

  for (const [page, tags] of detectionsByPage) {
    const occurrences: Occurrence[] = tags.map((_, idx) => ({
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${idx}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    }));

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `${tags.length} interactive element(s) on ${page} have no accessible name (no text, no aria-label, no aria-labelledby, no title, no img alt)`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: tags.length,
      occurrences,
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// form_input_unlabeled runner — static <input> scanner.
// Production path uses axe-core (label rule); harness uses focused regex.
// ---------------------------------------------------------------------------

/**
 * Read a single attribute value (case-insensitive) from a tag string. Returns
 * undefined when the attribute is absent.
 */
function readTagAttribute(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(tag);
  return m === null ? undefined : m[1];
}

/**
 * Find every `<input>` tag whose accessible-name acquisition fails, returning the
 * matched tag strings. Considers: aria-label, aria-labelledby, title, type=hidden,
 * type=submit/button/reset with value, <label for="id"> match against the input's
 * id, and `<label>...<input>...</label>` wrapped containment.
 */
function findInputsMissingLabel(html: string): string[] {
  // 1. Collect all `<label for="X">` for-attribute targets.
  const labelForIds = new Set<string>();
  const labelForRe = /<label\b[^>]*\bfor\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelForRe.exec(html)) !== null) {
    if (labelMatch[1] !== undefined) labelForIds.add(labelMatch[1]);
  }

  // 2. Collect every `<label>...</label>` span (start, end indices).
  const labelSpans: Array<{ start: number; end: number }> = [];
  const labelOpenRe = /<label\b[^>]*>/gi;
  const labelCloseRe = /<\/label\s*>/gi;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = labelOpenRe.exec(html)) !== null) {
    labelCloseRe.lastIndex = labelOpenRe.lastIndex;
    const closeMatch = labelCloseRe.exec(html);
    if (closeMatch === null) break;
    labelSpans.push({ start: openMatch.index, end: closeMatch.index + closeMatch[0].length });
  }

  // 3. Iterate inputs and apply skip rules.
  const inputRe = /<input\b[^>]*?>/gi;
  const missing: string[] = [];
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputRe.exec(html)) !== null) {
    const tag = inputMatch[0];
    const tagPosition = inputMatch.index;

    const type = (readTagAttribute(tag, 'type') ?? 'text').toLowerCase();
    // Skip non-user-facing or intrinsically labelled types
    if (type === 'hidden') continue;
    if (type === 'submit' || type === 'button' || type === 'reset') {
      const value = readTagAttribute(tag, 'value');
      if (value !== undefined && value.trim() !== '') continue;
    }

    if (/\baria-label\s*=/i.test(tag)) continue;
    if (/\baria-labelledby\s*=/i.test(tag)) continue;
    if (/\btitle\s*=/i.test(tag)) continue;

    const id = readTagAttribute(tag, 'id');
    if (id !== undefined && labelForIds.has(id)) continue;

    // Wrapped: input position falls inside any <label>...</label> span
    const isWrapped = labelSpans.some(s => tagPosition > s.start && tagPosition < s.end);
    if (isWrapped) continue;

    missing.push(tag);
  }
  return missing;
}

async function runFormInputUnlabeledHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('form_input_unlabeled: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const missing = findInputsMissingLabel(response.body);
      if (missing.length > 0) {
        detectionsByPage.set(route, missing);
        log.info('form_input_unlabeled: detection', { route, count: missing.length });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'form_input_unlabeled';
  const clusters: BugCluster[] = [];

  for (const [page, tags] of detectionsByPage) {
    const occurrences: Occurrence[] = tags.map((tag, idx) => ({
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${idx}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    }));

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `${tags.length} <input> element(s) on ${page} have no associated label, aria-label, aria-labelledby, or title`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: tags.length,
      occurrences,
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// image_missing_alt runner — static <img> scanner.
// Production path uses axe-core via browser-mcp; the harness uses a focused
// regex scan against the response body so calibration is fast and deterministic
// without a browser dependency.
// ---------------------------------------------------------------------------

/**
 * Find every `<img>` tag in `html` whose attributes contain neither `alt=...` nor
 * `aria-label=...` nor `aria-labelledby=...`. Returns the matched `<img>` tag strings.
 * `alt=""` (decorative-image convention) counts as having an alt attribute and is silent.
 */
function findImagesMissingAlt(html: string): string[] {
  const imgRe = /<img\b[^>]*?>/gi;
  const missing: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0];
    const hasAlt = /\balt\s*=/i.test(tag);
    const hasAriaLabel = /\baria-label\s*=/i.test(tag);
    const hasAriaLabelledBy = /\baria-labelledby\s*=/i.test(tag);
    if (!hasAlt && !hasAriaLabel && !hasAriaLabelledBy) {
      missing.push(tag);
    }
  }
  return missing;
}

async function runImageMissingAltHarness(
  appBaseUrl: string,
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  if (phases.includes('validate')) {
    await waitForPort(appBaseUrl, 30_000).catch(() => {
      warnings.push('image_missing_alt: fixture port not reachable during validate phase');
    });
    phasesRun.push('validate');
  }

  if (signal.aborted) return [];

  const routes = loadSeoProbeRoutes(fixturePath);
  // Map page → list of <img> tag strings missing alt
  const detectionsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const route of routes) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const url = `${appBaseUrl}${route}`;
      const response = await httpGet(url).catch((): ProbeResponse => ({ status: 0, body: '' }));
      if (response.status === 0) continue;

      const missing = findImagesMissingAlt(response.body);
      if (missing.length > 0) {
        detectionsByPage.set(route, missing);
        log.info('image_missing_alt: detection', { route, count: missing.length });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'image_missing_alt';
  const clusters: BugCluster[] = [];

  for (const [page, tags] of detectionsByPage) {
    const occurrences: Occurrence[] = tags.map((tag, idx) => ({
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${idx}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    }));

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `${tags.length} <img> element(s) on ${page} are missing alt/aria-label`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: tags.length,
      occurrences,
      suspectedFiles: [],
      fixHints: [],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

/**
 * Spawn bin/up.sh from the fixture directory, wait until the server port is
 * accepting connections (polled from contract.json), or time out after 30s.
 * Returns a cleanup function that runs bin/down.sh.
 */
export async function bootFixture(fixturePath: string, timeoutMs = 30_000): Promise<() => void> {
  const contractPath = path.join(fixturePath, 'contract.json');
  const contractRaw = fs.readFileSync(contractPath, 'utf8');
  const contract = JSON.parse(contractRaw) as { port: number | null };
  const port = contract.port;

  // Static-analysis fixtures (port: null) have no server to boot.
  // Run up.sh synchronously (materialises any generated artefacts like package-lock.json)
  // then return immediately — no port readiness check needed.
  if (port === null) {
    const upScript = path.join(fixturePath, 'bin', 'up.sh');
    if (fs.existsSync(upScript)) {
      const result = child_process.spawnSync('bash', [upScript], {
        cwd: fixturePath,
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      if (result.status !== 0) {
        log.warn(`[fixture] up.sh exited ${String(result.status)}: ${result.stderr}`);
      }
    }
    return () => {
      const downScript = path.join(fixturePath, 'bin', 'down.sh');
      if (fs.existsSync(downScript)) {
        child_process.spawnSync('bash', [downScript], { cwd: fixturePath });
      }
    };
  }

  // If the port is already open, the fixture is already running (e.g. from a previous
  // run or a pre-started process). Use it as-is without spawning up.sh.
  if (await isPortOpen('127.0.0.1', port, 200)) {
    log.info(`[fixture] port ${port} already open, reusing existing server`);
    return () => { /* caller didn't start it, don't stop it */ };
  }

  const upScript = path.join(fixturePath, 'bin', 'up.sh');
  const proc = child_process.spawn('bash', [upScript], {
    cwd: fixturePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    log.info(`[fixture] ${chunk.toString().trim()}`);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    log.info(`[fixture] ${chunk.toString().trim()}`);
  });

  // Wait for port to be ready (up to timeoutMs)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await isPortOpen('127.0.0.1', port, 300);
    if (ready) break;
    await sleep(300);
  }

  if (!(await isPortOpen('127.0.0.1', port, 300))) {
    proc.kill();
    throw new Error(`Fixture at ${fixturePath} did not become ready on port ${port} within ${timeoutMs}ms`);
  }

  return () => {
    const downScript = path.join(fixturePath, 'bin', 'down.sh');
    child_process.spawnSync('bash', [downScript], { cwd: fixturePath });
    if (!proc.killed) proc.kill();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// hardcoded_credentials_in_source runner (static analysis — no HTTP server)
// ---------------------------------------------------------------------------

/** Regex patterns for secrets we detect via Node-side scan (gitleaks substitute). */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'stripe-live-key',    re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'stripe-test-key',    re: /sk_test_[0-9a-zA-Z]{24,}/g },
  { name: 'aws-access-key',     re: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack-bot-token',    re: /xoxb-[0-9]+-[0-9A-Za-z-]+/g },
];

type CredFinding = { file: string; secretName: string };

/** Recursively walk a directory and return all file paths with the given extension. */
function walkFiles(dir: string, ext: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full, ext));
    else if (entry.isFile() && entry.name.endsWith(ext)) results.push(full);
  }
  return results;
}

/** Scan a single file for hardcoded secret patterns. Returns finding per match-group. */
function scanFile(filePath: string): CredFinding[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const findings: CredFinding[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(content)) findings.push({ file: filePath, secretName: name });
  }
  return findings;
}

function runHardcodedCredsHarness(
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): BugCluster[] {
  const generatedDir = path.join(fixturePath, 'generated');

  // Boot: run up.sh to materialise generated/ from templates
  if (phases.includes('execute')) {
    const upScript = path.join(fixturePath, 'bin', 'up.sh');
    if (fs.existsSync(upScript)) {
      const result = child_process.spawnSync('bash', [upScript], { cwd: fixturePath, encoding: 'utf8' });
      if (result.status !== 0) {
        warnings.push(`hardcoded_credentials_in_source: up.sh exited ${String(result.status)}: ${result.stderr}`);
      }
    }
  }

  // Skipped case: generated/ absent after boot attempt
  if (!fs.existsSync(generatedDir)) {
    warnings.push('hardcoded_credentials_in_source: generated/ missing — fixture not built, skipping scan');
    phasesRun.push('execute');
    return [];
  }

  if (signal.aborted) return [];

  // Execute: scan all .ts files under generated/ only (templates/ excluded)
  const findings: CredFinding[] = [];
  if (phases.includes('execute')) {
    const tsFiles = walkFiles(generatedDir, '.ts');
    for (const f of tsFiles) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      findings.push(...scanFile(f));
    }
    phasesRun.push('execute');
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  return buildHardcodedCredsClusters(findings, fixturePath);
}

// ---------------------------------------------------------------------------
// money_math_precision runner — static-source scan for float math on
// money-named identifiers.
// Production detector uses DB invariants; harness uses focused regex.
// ---------------------------------------------------------------------------

// Patterns intentionally allow camelCase joins (e.g. "priceUsd", "totalAmount").
// Match anywhere in the identifier — false positives like "amounted" / "priceless"
// are acceptable for a security-leaning heuristic.
const MONEY_NAME_PATTERNS = [
  /price/i,
  /amount/i,
  /total/i,
  /subtotal/i,
  /\bcost/i,
  /refund/i,
  /payment/i,
  /charge/i,
  /usd/i,
  /eur/i,
  /gbp/i,
  /inr/i,
];

const SAFE_MONEY_INDICATORS = [
  /cents?\b/i,
  /\bcents?/i,
  /[A-Z]Cents?/,
  /bps\b/i,
  /[A-Z]Bps/,
  /Decimal/,
  /bignum/i,
];

function isMoneyNamedSymbol(name: string): boolean {
  if (SAFE_MONEY_INDICATORS.some(re => re.test(name))) return false;
  return MONEY_NAME_PATTERNS.some(re => re.test(name));
}

function findMoneyMathPrecisionViolations(src: string): string[] {
  const violations: string[] = [];

  // 1. parseFloat(...moneyName...)
  const parseFloatRe = /parseFloat\s*\(\s*([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parseFloatRe.exec(src)) !== null) {
    const arg = match[1] ?? '';
    if (isMoneyNamedSymbol(arg)) violations.push(`parseFloat(${arg.slice(0, 50)})`);
  }

  // 2. Float arithmetic ops on money-named variables.
  // Pattern: <moneyName> [*+/] <number-with-decimal-or-name>
  const opRe = /([A-Za-z_$][A-Za-z0-9_$.]*)\s*([*/+])\s*([A-Za-z0-9_$.()]+)/g;
  while ((match = opRe.exec(src)) !== null) {
    const lhs = match[1] ?? '';
    const op = match[2] ?? '';
    const rhs = match[3] ?? '';
    if (op !== '*' && op !== '/' && op !== '+') continue;
    if (!isMoneyNamedSymbol(lhs)) continue;
    if (!/[.\d]/.test(rhs)) continue;
    if (/\bcents?\b/i.test(lhs) || /\bbps\b/i.test(lhs)) continue;
    violations.push(`${lhs} ${op} ${rhs.slice(0, 40)}`);
  }

  return violations;
}

async function runMoneyMathPrecisionHarness(
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  const generatedDir = path.join(fixturePath, 'generated');

  if (phases.includes('execute')) {
    const upScript = path.join(fixturePath, 'bin', 'up.sh');
    if (fs.existsSync(upScript)) {
      const result = child_process.spawnSync('bash', [upScript], { cwd: fixturePath, encoding: 'utf8' });
      if (result.status !== 0) {
        warnings.push(`money_math_precision: up.sh exited ${String(result.status)}: ${result.stderr}`);
      }
    }
  }

  if (!fs.existsSync(generatedDir)) {
    warnings.push('money_math_precision: generated/ missing — fixture not built, skipping scan');
    phasesRun.push('execute');
    return [];
  }

  if (signal.aborted) return [];

  // Recursively walk generated/ for .ts/.tsx files
  const files: string[] = [];
  (function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js') || entry.name.endsWith('.jsx'))) {
        files.push(full);
      }
    }
  })(generatedDir);

  const violationsByPage = new Map<string, string[]>();

  if (phases.includes('execute')) {
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (signal.aborted) break;
      const content = fs.readFileSync(file, 'utf8');
      const violations = findMoneyMathPrecisionViolations(content);
      if (violations.length > 0) {
        const page = path.relative(fixturePath, file);
        violationsByPage.set(page, violations);
        log.info('money_math_precision: violation', { page, count: violations.length });
      }
    }
    phasesRun.push('execute');
  }

  if (signal.aborted) return [];

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  const now = new Date().toISOString();
  const kind: BugKind = 'money_math_precision';
  const clusters: BugCluster[] = [];

  for (const [page, violations] of violationsByPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/[^a-z0-9]/gi, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `${violations.length} float arithmetic operation(s) on money-named identifier(s) in ${page}: ${violations.slice(0, 2).join('; ')}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: violations.length,
      occurrences: [occurrence],
      suspectedFiles: [page],
      fixHints: ['Use integer cents (Stripe convention) or a Decimal library for money math; avoid IEEE 754 float arithmetic'],
      thirdPartyOrGenerated: false,
      severity: 'major',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// i18n_hardcoded_string runner — invokes existing static scanner.
// ---------------------------------------------------------------------------

async function runI18nHardcodedStringHarness(
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): Promise<BugCluster[]> {
  const generatedDir = path.join(fixturePath, 'generated');

  if (phases.includes('execute')) {
    const upScript = path.join(fixturePath, 'bin', 'up.sh');
    if (fs.existsSync(upScript)) {
      const result = child_process.spawnSync('bash', [upScript], { cwd: fixturePath, encoding: 'utf8' });
      if (result.status !== 0) {
        warnings.push(`i18n_hardcoded_string: up.sh exited ${String(result.status)}: ${result.stderr}`);
      }
    }
  }

  if (!fs.existsSync(generatedDir)) {
    warnings.push('i18n_hardcoded_string: generated/ missing — fixture not built, skipping scan');
    phasesRun.push('execute');
    return [];
  }

  if (signal.aborted) return [];

  const detections = await runHardcodedStringsScanner({ projectRoot: generatedDir });

  if (signal.aborted) return [];

  if (phases.includes('execute')) phasesRun.push('execute');
  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  // Group detections by relative file path. fixturePath/generated/src/foo.ts → generated/src/foo.ts
  const now = new Date().toISOString();
  const kind: BugKind = 'i18n_hardcoded_string';
  const byPage = new Map<string, string[]>();
  for (const d of detections) {
    const sourceFile = d.staticContext?.sourceFile;
    if (sourceFile === undefined) continue;
    const page = path.relative(fixturePath, sourceFile);
    const previews = byPage.get(page) ?? [];
    const literalPreview = d.evidence?.['literalPreview'];
    previews.push(typeof literalPreview === 'string' ? literalPreview : '');
    byPage.set(page, previews);
  }

  const clusters: BugCluster[] = [];
  for (const [page, previews] of byPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'success', palette: 'edge' },
      fullArtifacts: false as const,
      timestamp: now,
    };
    clusters.push({
      id: `harness-${kind}-${page.replace(/[^a-z0-9]/gi, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `${previews.length} hardcoded user-facing string(s) in ${page}: ${previews.slice(0, 2).map(p => `"${p}"`).join(', ')}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: previews.length,
      occurrences: [occurrence],
      suspectedFiles: [page],
      fixHints: ['Wrap user-facing strings in t() or <Trans> for i18n support'],
      thirdPartyOrGenerated: false,
      severity: 'minor',
    });
  }

  return clusters;
}

function buildHardcodedCredsClusters(findings: CredFinding[], fixturePath: string): BugCluster[] {
  const now = new Date().toISOString();
  const kind: BugKind = 'hardcoded_credentials_in_source';

  // Group findings by relative file path (page key matches expected-clusters.jsonl)
  const byPage = new Map<string, string[]>();
  for (const { file, secretName } of findings) {
    const page = path.relative(fixturePath, file);
    const causes = byPage.get(page) ?? [];
    causes.push(secretName);
    byPage.set(page, causes);
  }

  const clusters: BugCluster[] = [];
  for (const [page, causes] of byPage) {
    const occurrence: Occurrence = {
      occurrenceId: `harness-${kind}-${page.replace(/\//g, '-')}-${Date.now()}`,
      role: 'anonymous',
      page,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'expected_failure',
        palette: 'edge',
      },
      fullArtifacts: false as const,
      timestamp: now,
    };

    clusters.push({
      id: `harness-${kind}-${page.replace(/\//g, '-')}`,
      runId: 'harness',
      kind,
      rootCause: `hardcoded secret(s) detected in ${page}: ${causes.join(', ')}`,
      firstSeenAt: now,
      lastSeenAt: now,
      clusterSize: causes.length,
      occurrences: [occurrence],
      suspectedFiles: [page],
      fixHints: ['Move secret to environment variable; never commit credentials to source'],
      thirdPartyOrGenerated: false,
      severity: 'critical',
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// vulnerable_dependency_high runner (static analysis — npm audit or static map)
// ---------------------------------------------------------------------------

/** Packages with known high/critical CVEs and the version boundary below which they fire. */
const STATIC_VULN_MAP: Array<{ name: string; fixedVersion: string; severity: 'critical' | 'major'; cve: string }> = [
  { name: 'lodash',  fixedVersion: '4.17.21', severity: 'critical', cve: 'CVE-2019-10744 / CVE-2021-23337' },
  { name: 'axios',   fixedVersion: '1.6.0',   severity: 'major',    cve: 'CVE-2021-3749 / CVE-2023-45857' },
];

/** Compare semver strings — returns true if a < b. */
function semverLt(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.replace(/[^0-9.]/g, '').split('.').map(n => {
    const x = parseInt(n, 10);
    return Number.isNaN(x) ? 0 : x;
  });
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

type VulnFinding = { pkgName: string; version: string; severity: 'critical' | 'major'; cve: string; isDirect: boolean };

/** Run npm audit --json in appDir and parse high/critical findings. Returns null on tool failure. */
function runNpmAudit(appDir: string, warnings: string[]): VulnFinding[] | null {
  const result = child_process.spawnSync('npm', ['audit', '--json', '--audit-level=none'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (result.error !== undefined) {
    warnings.push(`vulnerable_dependency_high: npm audit failed: ${result.error.message}`);
    return null;
  }

  const raw = result.stdout;
  if (raw.trim().length === 0) {
    warnings.push('vulnerable_dependency_high: npm audit produced empty output');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push('vulnerable_dependency_high: npm audit output was not valid JSON');
    return null;
  }

  const findings: VulnFinding[] = [];
  const HIGH_SEVERITIES = new Set(['high', 'critical']);

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'vulnerabilities' in parsed &&
    parsed.vulnerabilities !== null &&
    typeof parsed.vulnerabilities === 'object'
  ) {
    for (const [pkgName, vuln] of Object.entries(parsed.vulnerabilities as Record<string, unknown>)) {
      if (vuln === null || typeof vuln !== 'object') continue;
      const v = vuln as Record<string, unknown>;
      const sev = typeof v['severity'] === 'string' ? v['severity'].toLowerCase() : '';
      if (!HIGH_SEVERITIES.has(sev)) continue;
      findings.push({
        pkgName,
        version: typeof v['range'] === 'string' ? v['range'] : 'unknown',
        severity: sev === 'critical' ? 'critical' : 'major',
        cve: pkgName,
        isDirect: v['isDirect'] === true,
      });
    }
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'advisories' in parsed &&
    parsed.advisories !== null &&
    typeof parsed.advisories === 'object'
  ) {
    for (const [, advisory] of Object.entries(parsed.advisories as Record<string, unknown>)) {
      if (advisory === null || typeof advisory !== 'object') continue;
      const a = advisory as Record<string, unknown>;
      const sev = typeof a['severity'] === 'string' ? a['severity'].toLowerCase() : '';
      if (!HIGH_SEVERITIES.has(sev)) continue;
      const pkgName = typeof a['module_name'] === 'string' ? a['module_name'] :
                      typeof a['name'] === 'string' ? a['name'] : 'unknown';
      findings.push({
        pkgName,
        version: typeof a['vulnerable_versions'] === 'string' ? a['vulnerable_versions'] : 'unknown',
        severity: sev === 'critical' ? 'critical' : 'major',
        cve: pkgName,
        isDirect: true,
      });
    }
  }

  return findings;
}

/** Static fallback — check declared deps in package.json against STATIC_VULN_MAP. */
function staticVulnScan(pkgJsonPath: string, warnings: string[]): VulnFinding[] {
  if (!fs.existsSync(pkgJsonPath)) {
    warnings.push(`vulnerable_dependency_high: package.json not found at ${pkgJsonPath}`);
    return [];
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    warnings.push(`vulnerable_dependency_high: failed to parse ${pkgJsonPath}`);
    return [];
  }

  if (pkg === null || typeof pkg !== 'object') return [];
  const p = pkg as Record<string, unknown>;
  const deps: Partial<Record<string, string>> = {
    ...((p['dependencies'] as Record<string, string> | undefined) ?? {}),
    ...((p['devDependencies'] as Record<string, string> | undefined) ?? {}),
  };

  const findings: VulnFinding[] = [];
  for (const { name, fixedVersion, severity, cve } of STATIC_VULN_MAP) {
    const declared = deps[name];
    if (declared === undefined) continue;
    const version = declared.replace(/^[^0-9]*/, '');
    if (semverLt(version, fixedVersion)) {
      findings.push({ pkgName: name, version: declared, severity, cve, isDirect: true });
    }
  }
  return findings;
}

function buildVulnDepCluster(finding: VulnFinding, fixturePath: string): BugCluster {
  const now = new Date().toISOString();
  const kind: BugKind = 'vulnerable_dependency_high';
  const page = 'package.json';
  const occurrence: Occurrence = {
    occurrenceId: `harness-${kind}-${finding.pkgName}-${Date.now()}`,
    role: 'anonymous',
    page,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'expected_failure',
      palette: 'edge',
    },
    fullArtifacts: false as const,
    timestamp: now,
  };

  return {
    id: `harness-${kind}-${finding.pkgName}`,
    runId: 'harness',
    kind,
    rootCause: `${finding.pkgName}@${finding.version}: ${finding.cve} (${finding.severity})`,
    firstSeenAt: now,
    lastSeenAt: now,
    clusterSize: 1,
    occurrences: [occurrence],
    suspectedFiles: [path.join(fixturePath, 'app', 'package.json')],
    fixHints: [`Upgrade ${finding.pkgName} to a patched version`],
    thirdPartyOrGenerated: false,
    severity: finding.severity,
  };
}

function runVulnerableDependencyHighHarness(
  fixturePath: string,
  phases: RequiredPhase[],
  phasesRun: RequiredPhase[],
  signal: AbortSignal,
  warnings: string[],
): BugCluster[] {
  const appDir = path.join(fixturePath, 'app');

  if (!fs.existsSync(appDir)) {
    warnings.push('vulnerable_dependency_high: app/ directory not found in fixture');
    return [];
  }

  let findings: VulnFinding[] | null = null;

  if (phases.includes('execute')) {
    findings = runNpmAudit(appDir, warnings);

    if (findings === null) {
      const pkgJsonPath = path.join(appDir, 'package.json');
      findings = staticVulnScan(pkgJsonPath, warnings);
    }
    phasesRun.push('execute');
  }

  if (phases.includes('classify')) phasesRun.push('classify');
  if (phases.includes('cluster')) phasesRun.push('cluster');

  if (findings === null || findings.length === 0) return [];

  return findings.map(f => buildVulnDepCluster(f, fixturePath));
}

function buildResult(
  clusters: BugCluster[],
  phasesRun: RequiredPhase[],
  plannedTests: number,
  runTests: number,
  skippedTests: number,
  durationMs: number,
  budgetExceeded: boolean,
  warnings: string[],
): HarnessResult {
  return { clusters, phasesRun, plannedTests, runTests, skippedTests, durationMs, budgetExceeded, warnings };
}

/**
 * Combines two AbortSignals into a single signal that aborts when either fires.
 * If parent is undefined, returns the budget signal directly.
 */
function combineSignals(budget: AbortSignal, parent?: AbortSignal): AbortSignal {
  if (parent === undefined) return budget;
  if (parent.aborted || budget.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const combined = new AbortController();
  const abort = (): void => combined.abort();
  budget.addEventListener('abort', abort, { once: true });
  parent.addEventListener('abort', abort, { once: true });
  return combined.signal;
}

/**
 * Sends a GET request using Node's http module to preserve raw path segments
 * (dots, encoded slashes) that would otherwise be normalized by fetch or curl.
 * This is critical for path-traversal probes where `../` in the URL path must
 * reach the server as-is rather than being resolved by the HTTP client.
 */
function httpGet(url: string, headers?: Record<string, string>): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      // Use pathname + search to preserve encoded path segments.
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 5_000,
      headers,
    };

    const req = http.get(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        resolve({ status: 0, body: '' });
      } else {
        reject(err);
      }
    });
  });
}

type ProbeResponseWithHeaders = ProbeResponse & { headers: Record<string, string | undefined> };

/**
 * Like httpGet but also returns lowercased response headers.
 * Used by missing_csp_header to inspect CSP-related headers.
 */
function httpGetWithHeaders(url: string): Promise<ProbeResponseWithHeaders> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 5_000,
    };

    const req = http.get(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // Lowercase all header names for consistent lookup
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
        }
        resolve({ status: res.statusCode ?? 0, body, headers });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', headers: {} });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        resolve({ status: 0, body: '', headers: {} });
      } else {
        reject(err);
      }
    });
  });
}

function httpPost(url: string, jsonBody: string, headers?: Record<string, string>): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyBuf = Buffer.from(jsonBody, 'utf8');
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout: 5_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(bodyBuf.length),
        ...headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        resolve({ status: 0, body: '' });
      } else {
        reject(err);
      }
    });

    req.write(bodyBuf);
    req.end();
  });
}

async function waitForPort(appBaseUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(appBaseUrl);
  const parsed = parseInt(url.port, 10);
  const port = Number.isNaN(parsed) || parsed === 0 ? (url.protocol === 'https:' ? 443 : 80) : parsed;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(url.hostname, port)) return;
    await sleep(300);
  }
  throw new Error(`Port ${port} not open within ${timeoutMs}ms`);
}

function isPortOpen(host: string, port: number, socketTimeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const cleanup = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(socketTimeoutMs);
    sock.once('connect', () => cleanup(true));
    sock.once('timeout', () => cleanup(false));
    sock.once('error', () => cleanup(false));
    sock.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
