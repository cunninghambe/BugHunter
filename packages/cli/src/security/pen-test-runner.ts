// v0.16 Pen-test runner — orchestrates active probing of SQL/CMD/PATH/JWT injection surfaces.
// Runs after execute, before classify. Uses a separate authed session (not the main BugHunter session).

import * as fs from 'node:fs';
import type { DiscoveredForm, ToolMeta, BugDetection } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { RateLimitProfile } from './rate-limit-discovery.js';
import { generatePenPayloads } from './injection-palette.js';
import type { PenKind, PenPayload } from './injection-palette.js';
import type { ProbeResponse } from './pen-detectors.js';
import {
  detectSqlInjectionError,
  detectSqlInjectionBoolean,
  detectCommandInjection,
  detectPathTraversal,
  detectJwtWeakAlg,
  BOOLEAN_DELTA_THRESHOLD,
} from './pen-detectors.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PenTestRunnerConfig = {
  enabled: boolean;
  targetTools: ToolMeta[];
  forms: DiscoveredForm[];
  variants: PenKind[];
  rateLimitProfile?: RateLimitProfile;
  jwtTargets?: string[];
  jwtPublicKeyPemPath?: string;
  maxProbesPerEndpoint?: number;
  booleanDeltaThreshold?: number;
};

export type PenTestRunnerResult = {
  detections: BugDetection[];
  telemetry: {
    probesAttempted: number;
    probesSucceeded: number;
    probesThrottled: number;
    probesSkipped: { reason: string; count: number }[];
    detectionsByKind: Record<string, number>;
  };
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function responseBodyString(body: unknown): string {
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return ''; }
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function interProbeDelay(profile: RateLimitProfile | undefined): number {
  return profile?.delayBetweenAttemptsMs ?? 200;
}

type SkipCounter = Map<string, number>;

function addSkip(counter: SkipCounter, reason: string): void {
  counter.set(reason, (counter.get(reason) ?? 0) + 1);
}

function buildSkipArray(counter: SkipCounter): { reason: string; count: number }[] {
  return [...counter.entries()].map(([reason, count]) => ({ reason, count }));
}

/** Call a surface tool with the given input; handle 429 with up to 3 retries. */
async function surfaceCallWithRetry(
  surface: SurfaceMcpAdapter,
  toolId: string,
  input: Record<string, unknown>,
  extraHeaders: Record<string, string>,
  throttleCounter: { count: number },
): Promise<ProbeResponse | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try {
      result = await surface.surface_call({
        toolId,
        role: 'anonymous',
        input: { ...input, ...extraHeaders },
        noAutoRelogin: true,
      });
    } catch (err) {
      log.warn('pen-test-runner: surface_call error', { toolId, err: String(err) });
      return null;
    }

    if (result.status === 429) {
      throttleCounter.count += 1;
      // Respect Retry-After if present; default 30s.
      const retryAfterMs = parseRetryAfter(result.headers) ?? 30_000;
      log.info('pen-test-runner: 429 — pausing', { toolId, retryAfterMs });
      await delayMs(retryAfterMs);
      continue;
    }

    const body = responseBodyString(result.body);
    return { status: result.status ?? 0, body };
  }

  // 3 attempts exhausted
  return null;
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined) return null;
  const seconds = parseInt(raw, 10);
  return Number.isNaN(seconds) ? null : seconds * 1000;
}

/** Try to read the RSA public key PEM from the configured path. */
function loadRsaPublicKey(pemPath: string | undefined): string | null {
  if (pemPath === undefined) return null;
  try {
    return fs.readFileSync(pemPath, 'utf8');
  } catch {
    log.warn('pen-test-runner: could not read jwtPublicKeyPemPath', { pemPath });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-endpoint probe logic
// ---------------------------------------------------------------------------

/** Build the HTTP input body for probing a specific param with a payload value. */
function probeInput(
  tool: ToolMeta,
  paramName: string,
  payloadValue: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (tool.inputSchema.properties !== undefined) {
    for (const key of Object.keys(tool.inputSchema.properties)) {
      base[key] = '';
    }
  }
  base[paramName] = payloadValue;
  return base;
}

async function probeToolParam(
  surface: SurfaceMcpAdapter,
  tool: ToolMeta,
  paramName: string,
  payload: PenPayload,
  cfg: PenTestRunnerConfig,
  detections: BugDetection[],
  telemetry: { attempted: number; succeeded: number; throttled: number },
  skipCounter: SkipCounter,
): Promise<void> {
  const delay = interProbeDelay(cfg.rateLimitProfile);
  const endpoint = `${tool.method} ${tool.path}`;
  const throttleCounter = { count: 0 };

  // JWT probes — only on jwtTargets
  if (payload.kind === 'jwt') {
    const jwtTargets = cfg.jwtTargets ?? [];
    if (jwtTargets.length === 0) {
      addSkip(skipCounter, 'no_jwt_targets');
      return;
    }
    if (!jwtTargets.some(t => tool.path.startsWith(t))) {
      addSkip(skipCounter, 'jwt_target_not_matched');
      return;
    }
  }

  // Send GET endpoints with Cache-Control: no-cache (EC-9)
  const extraHeaders: Record<string, string> = tool.method.toUpperCase() === 'GET'
    ? { 'Cache-Control': 'no-cache' }
    : {};

  // Boolean SQL variants need baseline + true + false calls
  if (payload.variant === 'boolean_true' || payload.variant === 'boolean_false') {
    // Handled in the boolean batch below — skip individual probe here
    return;
  }

  telemetry.attempted += 1;
  await delayMs(delay);
  const response = await surfaceCallWithRetry(
    surface,
    tool.toolId,
    probeInput(tool, paramName, payload.value),
    extraHeaders,
    throttleCounter,
  );
  telemetry.throttled += throttleCounter.count;
  if (response === null) return;

  telemetry.succeeded += 1;
  const detection = runDetector(payload, response, paramName, endpoint, cfg);
  if (detection !== null) detections.push(detection);
}

function runDetector(
  payload: PenPayload,
  response: ProbeResponse,
  paramName: string,
  endpoint: string,
  _cfg: PenTestRunnerConfig,
): BugDetection | null {
  switch (payload.kind) {
    case 'sql': {
      const result = detectSqlInjectionError(payload, response, paramName, endpoint);
      return result.ok ? result.detection : null;
    }
    case 'cmd': {
      const result = detectCommandInjection(payload, response, paramName, endpoint);
      return result.ok ? result.detection : null;
    }
    case 'path': {
      const result = detectPathTraversal(payload, response, paramName, endpoint);
      return result.ok ? result.detection : null;
    }
    case 'jwt': {
      const secretUsed = payload.variant === 'weak_hmac_short_secret' ? 'secret' : undefined;
      const result = detectJwtWeakAlg(payload, response, endpoint, secretUsed);
      return result.ok ? result.detection : null;
    }
  }
}

/** Handle the boolean SQL pair (true + false) against a single endpoint+param. */
async function probeSqlBoolean(
  surface: SurfaceMcpAdapter,
  tool: ToolMeta,
  paramName: string,
  truePayload: PenPayload,
  falsePayload: PenPayload,
  cfg: PenTestRunnerConfig,
  detections: BugDetection[],
  telemetry: { attempted: number; succeeded: number; throttled: number },
): Promise<void> {
  const delay = interProbeDelay(cfg.rateLimitProfile);
  const endpoint = `${tool.method} ${tool.path}`;
  const extraHeaders: Record<string, string> = tool.method.toUpperCase() === 'GET'
    ? { 'Cache-Control': 'no-cache' }
    : {};

  // Baseline (empty param)
  telemetry.attempted += 1;
  await delayMs(delay);
  const throttleBaseline = { count: 0 };
  const baseline = await surfaceCallWithRetry(surface, tool.toolId, probeInput(tool, paramName, ''), extraHeaders, throttleBaseline);
  telemetry.throttled += throttleBaseline.count;
  if (baseline === null) return;
  telemetry.succeeded += 1;

  // True
  telemetry.attempted += 1;
  await delayMs(delay);
  const throttleTrue = { count: 0 };
  const trueResp = await surfaceCallWithRetry(surface, tool.toolId, probeInput(tool, paramName, truePayload.value), extraHeaders, throttleTrue);
  telemetry.throttled += throttleTrue.count;
  if (trueResp === null) return;
  telemetry.succeeded += 1;

  // False
  telemetry.attempted += 1;
  await delayMs(delay);
  const throttleFalse = { count: 0 };
  const falseResp = await surfaceCallWithRetry(surface, tool.toolId, probeInput(tool, paramName, falsePayload.value), extraHeaders, throttleFalse);
  telemetry.throttled += throttleFalse.count;
  if (falseResp === null) return;
  telemetry.succeeded += 1;

  const threshold = cfg.booleanDeltaThreshold ?? BOOLEAN_DELTA_THRESHOLD;
  const result = detectSqlInjectionBoolean(truePayload, trueResp, falseResp, baseline, paramName, endpoint, threshold);
  if (result.ok) detections.push(result.detection);
}

/** Return all string-type param names from a tool's input schema. */
function stringParamNames(tool: ToolMeta): string[] {
  const props = tool.inputSchema.properties;
  if (props === undefined) return [];
  return Object.entries(props)
    .filter(([, schema]) => schema.type === 'string')
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run pen-tests against all targetTools. Returns detections + telemetry.
 * Uses a separate authed session (role='anonymous' with noAutoRelogin)
 * so the main BugHunter session is never polluted.
 */
export async function runPenTests(
  cfg: PenTestRunnerConfig,
  surface: SurfaceMcpAdapter,
): Promise<PenTestRunnerResult> {
  if (!cfg.enabled) {
    return {
      detections: [],
      telemetry: {
        probesAttempted: 0,
        probesSucceeded: 0,
        probesThrottled: 0,
        probesSkipped: [],
        detectionsByKind: {},
      },
    };
  }

  loadRsaPublicKey(cfg.jwtPublicKeyPemPath); // validate path early; result used per-variant below
  const rsaPublicKey = loadRsaPublicKey(cfg.jwtPublicKeyPemPath);

  const detections: BugDetection[] = [];
  const skipCounter: SkipCounter = new Map();
  const telemetry = { attempted: 0, succeeded: 0, throttled: 0 };

  for (const tool of cfg.targetTools) {
    const params = stringParamNames(tool);
    if (params.length === 0) continue;

    const payloads = generatePenPayloads(cfg.variants);
    const sqlBooleanTrue = payloads.find(p => p.kind === 'sql' && p.variant === 'boolean_true');
    const sqlBooleanFalse = payloads.find(p => p.kind === 'sql' && p.variant === 'boolean_false');

    for (const paramName of params) {
      for (const payload of payloads) {
        // Skip rs_to_hs if no public key available
        if (payload.variant === 'key_confusion_rs_to_hs' && rsaPublicKey === null) {
          addSkip(skipCounter, 'no_jwt_public_key');
          continue;
        }

        // Boolean pair handled separately below
        if (payload.variant === 'boolean_true' || payload.variant === 'boolean_false') continue;

        await probeToolParam(surface, tool, paramName, payload, cfg, detections, telemetry, skipCounter);
      }

      // Boolean SQL pair
      if (
        cfg.variants.includes('sql') &&
        sqlBooleanTrue !== undefined &&
        sqlBooleanFalse !== undefined
      ) {
        await probeSqlBoolean(
          surface, tool, paramName,
          sqlBooleanTrue, sqlBooleanFalse,
          cfg, detections, telemetry,
        );
      }
    }
  }

  const detectionsByKind: Record<string, number> = {};
  for (const d of detections) {
    detectionsByKind[d.kind] = (detectionsByKind[d.kind] ?? 0) + 1;
  }

  return {
    detections,
    telemetry: {
      probesAttempted: telemetry.attempted,
      probesSucceeded: telemetry.succeeded,
      probesThrottled: telemetry.throttled,
      probesSkipped: buildSkipArray(skipCounter),
      detectionsByKind,
    },
  };
}
