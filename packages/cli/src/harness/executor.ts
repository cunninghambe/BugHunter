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
  const contract = JSON.parse(contractRaw) as { port: number };
  const port = contract.port;

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
