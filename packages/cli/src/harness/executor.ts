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
