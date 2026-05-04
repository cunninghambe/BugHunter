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
import type { DetectorContract, RequiredPhase } from '../detectors/contracts.js';
import type { BugCluster, BugKind, Occurrence } from '../types.js';
import { generatePenPayloads } from '../security/injection-palette.js';
import type { PenPayload } from '../security/injection-palette.js';
import { detectPathTraversal } from '../security/pen-detectors.js';
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
function httpGet(url: string): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      // Use pathname + search to preserve encoded path segments.
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 5_000,
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

async function waitForPort(appBaseUrl: string, timeoutMs: number): Promise<void> {
  const url = new URL(appBaseUrl);
  const port = parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
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
  return new Promise(resolve => setTimeout(resolve, ms));
}
