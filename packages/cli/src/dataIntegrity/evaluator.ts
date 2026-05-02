// v0.42: invariant evaluator — pre/post action snapshot + expectation evaluation.
// Calls seed/runner.ts for HTTP and shell queries; no second transport stack.

import type {
  DataIntegrityInvariant, DataIntegrityExtra, InvariantEvaluation, InvariantPhase,
  InvariantQuery, TestCase, BugDetection, Expectation, SeedHook,
} from '../types.js';
import { runSeedHook } from '../seed/runner.js';
import { log } from '../log.js';
import { extractJsonPath } from './jsonpath.js';
import { resolveTemplate, resolveValue } from './template.js';
import type { ActionResult } from './buildDetection.js';
import { buildDataIntegrityDetection } from './buildDetection.js';

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export type { ActionResult };

export type EvaluatorContext = {
  projectDir: string;
  appBaseUrl: string;
  role?: string;
  runId: string;
};

export type PendingInvariantSnapshot = {
  inv: DataIntegrityInvariant;
  tc: TestCase;
  beforeStore: Record<string, unknown>;
};

/**
 * Run before queries for each invariant and return pending snapshots.
 * Called BEFORE runAction.
 */
export async function snapshotInvariantsBefore(
  invariants: DataIntegrityInvariant[],
  tc: TestCase,
  ctx: EvaluatorContext,
): Promise<PendingInvariantSnapshot[]> {
  const pending: PendingInvariantSnapshot[] = [];
  for (const inv of invariants) {
    if (inv.before === undefined) {
      pending.push({ inv, tc, beforeStore: {} });
      continue;
    }
    const runtimeCtx = buildRuntimeContext(tc, undefined, ctx);
    const store = await runPhaseStore(inv.before, inv, runtimeCtx, ctx);
    pending.push({ inv, tc, beforeStore: store });
  }
  return pending;
}

/**
 * Run after queries for each pending snapshot, evaluate expectations,
 * and return evaluation records + any detections to emit.
 * Called AFTER runAction.
 */
export async function evaluateInvariantsAfter(
  pending: PendingInvariantSnapshot[],
  tc: TestCase,
  actionResult: ActionResult,
  ctx: EvaluatorContext,
): Promise<{ evaluations: InvariantEvaluation[]; detections: BugDetection[] }> {
  const evaluations: InvariantEvaluation[] = [];
  const detections: BugDetection[] = [];
  const start = Date.now();

  for (const { inv, beforeStore } of pending) {
    const evalStart = Date.now();
    const runtimeCtx = buildRuntimeContext(tc, actionResult, ctx);
    const templateCtx = { extract: {} as Record<string, unknown>, beforeStore, runtime: runtimeCtx };

    // Resolve extract clauses
    if (inv.extract !== undefined) {
      for (const [key, clause] of Object.entries(inv.extract)) {
        const val = resolveExtractClause(clause, tc, actionResult);
        templateCtx.extract[key] = val ?? '';
      }
    }

    if (inv.after === undefined) {
      // idempotency_key_violation: handle replay
      if (inv.bugKind === 'idempotency_key_violation' && inv.replay !== undefined) {
        const eval_ = await evaluateIdempotency(inv, tc, actionResult, beforeStore, templateCtx, ctx);
        evaluations.push({ ...eval_, durationMs: Date.now() - evalStart });
        if (eval_.outcome === 'violated' && eval_.detectionEmitted === true) {
          const extra: DataIntegrityExtra = {
            kind: 'idempotency_key_violation',
            invariantName: inv.name,
            idempotencyKey: actionResult.idempotencyKey,
            firstResponse: { status: actionResult.status ?? 0, body: actionResult.responseBody },
            secondResponse: undefined,
          };
          detections.push(buildDataIntegrityDetection(inv, tc, actionResult, extra));
        }
      } else {
        evaluations.push({
          invariantName: inv.name, bugKind: inv.bugKind, actionId: tc.id,
          durationMs: Date.now() - evalStart, ok: true, outcome: 'skipped',
          reason: 'no after clause',
        });
      }
      continue;
    }

    const afterResult = await runPhaseAndEvaluate(inv.after, inv, templateCtx, ctx);
    const durationMs = Date.now() - evalStart;

    if (afterResult.outcome === 'query_failed') {
      evaluations.push({
        invariantName: inv.name, bugKind: inv.bugKind, actionId: tc.id,
        durationMs, ok: false, outcome: 'query_failed', reason: afterResult.reason,
        before: Object.keys(beforeStore).length > 0 ? beforeStore : undefined,
      });
      if (inv.continueOnError !== true) {
        const surfaceFailedDetection: BugDetection = {
          kind: 'surface_call_failed',
          rootCause: `data_integrity invariant query failed: ${inv.name} — ${afterResult.reason ?? 'unknown'}`,
          pageRoute: tc.page,
          triggeringAction: tc.action,
        };
        detections.push(surfaceFailedDetection);
      }
      continue;
    }

    const violated = afterResult.outcome === 'violated';
    const evaluation: InvariantEvaluation = {
      invariantName: inv.name, bugKind: inv.bugKind, actionId: tc.id,
      durationMs, ok: !violated, outcome: afterResult.outcome,
      reason: afterResult.reason,
      before: Object.keys(beforeStore).length > 0 ? beforeStore : undefined,
      after: afterResult.afterStore,
      detectionEmitted: violated,
    };
    evaluations.push(evaluation);

    if (violated) {
      const extra = buildExtra(inv, tc, actionResult, afterResult.afterStore ?? {}, beforeStore, templateCtx);
      detections.push(buildDataIntegrityDetection(inv, tc, actionResult, extra));
    }

    log.info('data_integrity: invariant evaluated', {
      invariantName: inv.name, actionId: tc.id, outcome: afterResult.outcome, durationMs,
    });
  }

  void start;
  return { evaluations, detections };
}

// ---------------------------------------------------------------------------
// Phase execution helpers
// ---------------------------------------------------------------------------

type PhaseResult = {
  outcome: 'passed' | 'violated' | 'skipped' | 'query_failed';
  reason?: string;
  afterStore?: Record<string, unknown>;
};

async function runPhaseStore(
  phase: InvariantPhase,
  inv: DataIntegrityInvariant,
  runtimeCtx: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<Record<string, unknown>> {
  const queries = 'queries' in phase ? phase.queries : [phase];
  const store: Record<string, unknown> = {};
  for (const q of queries) {
    const output = await runQueryWithRetry(q, inv, { extract: {}, beforeStore: {}, runtime: runtimeCtx }, ctx);
    if (output === null) continue;
    const parsed = parseOutput(output, q.parse);
    if (q.store !== undefined) {
      for (const [storeKey, jsonPathExpr] of Object.entries(q.store)) {
        store[storeKey] = extractJsonPath(parsed, jsonPathExpr);
      }
    }
  }
  return store;
}

async function runPhaseAndEvaluate(
  phase: InvariantPhase,
  inv: DataIntegrityInvariant,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
  ctx: EvaluatorContext,
): Promise<PhaseResult> {
  const queries = 'queries' in phase ? phase.queries : [phase];
  const afterStore: Record<string, unknown> = {};
  let anyViolation: { reason: string; name?: string } | undefined;

  for (const q of queries) {
    const output = await runQueryWithRetry(q, inv, templateCtx, ctx);
    if (output === null) {
      return { outcome: 'query_failed', reason: `query failed: ${q.name ?? 'unnamed'}` };
    }

    const parsed = parseOutput(output, q.parse);

    if (q.store !== undefined) {
      for (const [storeKey, jsonPathExpr] of Object.entries(q.store)) {
        afterStore[storeKey] = extractJsonPath(parsed, jsonPathExpr);
      }
    }

    if (q.expect !== undefined) {
      const result = evaluateExpectation(q.expect, parsed, templateCtx);
      if (!result.passed) {
        anyViolation = { reason: result.reason, name: q.name };
      }
    }
  }

  if (anyViolation !== undefined) {
    const subQueryInfo = anyViolation.name !== undefined ? ` (sub-query: ${anyViolation.name})` : '';
    return {
      outcome: 'violated',
      reason: `${anyViolation.reason}${subQueryInfo}`,
      afterStore,
    };
  }

  return { outcome: 'passed', afterStore };
}

async function runQueryWithRetry(
  q: InvariantQuery,
  inv: DataIntegrityInvariant,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
  ctx: EvaluatorContext,
): Promise<string | null> {
  const hook = resolveQueryHook(q.query, templateCtx);
  const timeoutMs = q.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const hooWithTimeout: SeedHook = { ...hook, timeoutMs };
  const retryCount = q.retry?.count ?? 0;
  const retryDelayMs = q.retry?.delayMs ?? 0;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) await delay(retryDelayMs);
    const exec = await runSeedHook(hooWithTimeout, {
      projectDir: ctx.projectDir,
      appBaseUrl: ctx.appBaseUrl,
      role: ctx.role,
      lifecyclePoint: 'afterEach',
    });
    if (exec.ok && exec.output !== undefined) return exec.output;
  }

  log.warn('data_integrity: query failed after retries', { invariantName: inv.name, queryName: q.name });
  return null;
}

function resolveQueryHook(
  hook: SeedHook,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
): SeedHook {
  try {
    if (hook.kind === 'http') {
      const url = resolveTemplate(hook.url, templateCtx);
      const headers = hook.headers !== undefined
        ? Object.fromEntries(Object.entries(hook.headers).map(([k, v]) => [k, resolveTemplate(v, templateCtx)]))
        : undefined;
      return { ...hook, url, ...(headers !== undefined ? { headers } : {}) };
    }
    if (hook.kind === 'shell') {
      const command = resolveTemplate(hook.command, templateCtx);
      return { ...hook, command };
    }
  } catch {
    // Template resolution failed — return hook as-is; runSeedHook will fail naturally
  }
  return hook;
}

// ---------------------------------------------------------------------------
// Expectation evaluation
// ---------------------------------------------------------------------------

type ExpectResult = { passed: boolean; reason: string };

function evaluateExpectation(
  expect: Expectation,
  parsed: unknown,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
): ExpectResult {
  const subject = expect.jsonPath !== undefined ? extractJsonPath(parsed, expect.jsonPath) : parsed;
  const expectedRaw = resolveValue(expect.value, templateCtx);

  switch (expect.op) {
    case 'equals':
      if (subject !== expectedRaw) return fail(`equals: expected ${JSON.stringify(expectedRaw)}, got ${JSON.stringify(subject)}`);
      return pass();

    case 'notEquals':
      if (subject === expectedRaw) return fail(`notEquals: value should not equal ${JSON.stringify(expectedRaw)}`);
      return pass();

    case 'lengthEquals': {
      const len = getLength(subject);
      const want = Number(expectedRaw);
      if (len !== want) return fail(`lengthEquals: expected length ${want}, got ${len}`);
      return pass();
    }

    case 'lengthGte': {
      const len = getLength(subject);
      const want = Number(expectedRaw);
      if (len < want) return fail(`lengthGte: expected length >= ${want}, got ${len}`);
      return pass();
    }

    case 'lengthLte': {
      const len = getLength(subject);
      const want = Number(expectedRaw);
      if (len > want) return fail(`lengthLte: expected length <= ${want}, got ${len}`);
      return pass();
    }

    case 'numericEquals': {
      const tolerance = expect.tolerance ?? 0;
      const got = Number(subject);
      const want = Number(expectedRaw);
      if (Number.isNaN(got) || Number.isNaN(want)) return fail(`numericEquals: non-numeric values (got ${JSON.stringify(subject)}, expected ${JSON.stringify(expectedRaw)})`);
      if (Math.abs(got - want) > tolerance) return fail(`numericEquals: |${got} - ${want}| = ${Math.abs(got - want)} > tolerance ${tolerance}`);
      return pass();
    }

    case 'contains': {
      if (Array.isArray(subject)) {
        if (!subject.includes(expectedRaw)) return fail(`contains: array does not contain ${JSON.stringify(expectedRaw)}`);
      } else if (typeof subject === 'string') {
        if (!subject.includes(String(expectedRaw))) return fail(`contains: string does not contain ${JSON.stringify(expectedRaw)}`);
      } else {
        return fail(`contains: subject is not array or string`);
      }
      return pass();
    }

    case 'notContains': {
      if (Array.isArray(subject)) {
        if (subject.includes(expectedRaw)) return fail(`notContains: array contains ${JSON.stringify(expectedRaw)}`);
      } else if (typeof subject === 'string') {
        if (subject.includes(String(expectedRaw))) return fail(`notContains: string contains ${JSON.stringify(expectedRaw)}`);
      } else {
        return fail(`notContains: subject is not array or string`);
      }
      return pass();
    }

    case 'matches': {
      const pattern = new RegExp(String(expectedRaw));
      if (!pattern.test(String(subject))) return fail(`matches: ${JSON.stringify(subject)} does not match /${expectedRaw}/`);
      return pass();
    }
  }
}

function pass(): ExpectResult { return { passed: true, reason: 'ok' }; }
function fail(reason: string): ExpectResult { return { passed: false, reason }; }

function getLength(val: unknown): number {
  if (Array.isArray(val)) return val.length;
  if (typeof val === 'string') return val.length;
  if (val === null || val === undefined) return 0;
  if (typeof val === 'object') return Object.keys(val).length;
  return 0;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseOutput(output: string, format: InvariantQuery['parse']): unknown {
  switch (format) {
    case 'json':
      try { return JSON.parse(output); } catch { return output; }
    case 'jsonl':
      return output.split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l); } catch { return l; } });
    case 'integer':
      return parseInt(output.trim(), 10);
    case 'text':
    default:
      return output;
  }
}

// ---------------------------------------------------------------------------
// Extract clause resolution
// ---------------------------------------------------------------------------

function resolveExtractClause(
  clause: DataIntegrityInvariant['extract'] extends Record<string, infer C> | undefined ? C : never,
  tc: TestCase,
  actionResult: ActionResult,
): unknown {
  switch (clause.from) {
    case 'actionUrl': {
      const url = actionResult.url ?? tc.page;
      if (clause.regex !== undefined) {
        const m = url.match(new RegExp(clause.regex));
        return m?.[1];
      }
      if (clause.jsonPath !== undefined) return extractJsonPath(url, clause.jsonPath);
      return url;
    }
    case 'actionRequestBody': {
      if (clause.jsonPath !== undefined) return extractJsonPath(actionResult.requestBody, clause.jsonPath);
      if (clause.regex !== undefined) {
        const bodyStr = JSON.stringify(actionResult.requestBody ?? '');
        const m = bodyStr.match(new RegExp(clause.regex));
        return m?.[1];
      }
      return actionResult.requestBody;
    }
    case 'actionResponseBody': {
      if (clause.jsonPath !== undefined) return extractJsonPath(actionResult.responseBody, clause.jsonPath);
      return actionResult.responseBody;
    }
    case 'actionRequestHeaders': {
      if (clause.jsonPath !== undefined && actionResult.requestHeaders !== undefined) {
        return extractJsonPath(actionResult.requestHeaders, clause.jsonPath);
      }
      return actionResult.requestHeaders;
    }
    case 'literal':
      return clause.literal;
    case 'beforeSnapshot':
      // beforeSnapshot extract must be resolved against the store — handled at template level
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Idempotency handling
// ---------------------------------------------------------------------------

async function evaluateIdempotency(
  inv: DataIntegrityInvariant,
  tc: TestCase,
  actionResult: ActionResult,
  beforeStore: Record<string, unknown>,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
  ctx: EvaluatorContext,
): Promise<InvariantEvaluation> {
  // idempotency_key_violation requires an idempotency key header on the original action
  if (actionResult.idempotencyKey === undefined) {
    return {
      invariantName: inv.name, bugKind: inv.bugKind, actionId: tc.id,
      durationMs: 0, ok: true, outcome: 'skipped', reason: 'no-idempotency-key',
      before: Object.keys(beforeStore).length > 0 ? beforeStore : undefined,
    };
  }

  // Evaluate after clause if present
  let afterResult: PhaseResult = { outcome: 'passed' };
  if (inv.after !== undefined) {
    afterResult = await runPhaseAndEvaluate(inv.after, inv, templateCtx, ctx);
  }

  const violated = afterResult.outcome === 'violated';
  return {
    invariantName: inv.name, bugKind: inv.bugKind, actionId: tc.id,
    durationMs: 0, ok: !violated, outcome: afterResult.outcome,
    reason: afterResult.reason,
    before: Object.keys(beforeStore).length > 0 ? beforeStore : undefined,
    after: afterResult.afterStore,
    detectionEmitted: violated,
  };
}

// ---------------------------------------------------------------------------
// Extra payload builders
// ---------------------------------------------------------------------------

function buildExtra(
  inv: DataIntegrityInvariant,
  tc: TestCase,
  actionResult: ActionResult,
  afterStore: Record<string, unknown>,
  beforeStore: Record<string, unknown>,
  templateCtx: { extract: Record<string, unknown>; beforeStore: Record<string, unknown>; runtime: Record<string, unknown> },
): DataIntegrityExtra {
  switch (inv.bugKind) {
    case 'data_integrity_orphan':
      return {
        kind: 'data_integrity_orphan',
        invariantName: inv.name,
        orphanedCount: Number(afterStore['count'] ?? 0),
        queryResult: afterStore,
      };
    case 'money_math_precision':
      return {
        kind: 'money_math_precision',
        invariantName: inv.name,
        storedValue: afterStore['amount'],
        expectedValue: templateCtx.extract['sentAmount'],
      };
    case 'cache_staleness':
      return {
        kind: 'cache_staleness',
        invariantName: inv.name,
        expectedValue: templateCtx.extract['newValue'],
        staleValue: afterStore['observed'],
      };
    case 'idempotency_key_violation':
      return {
        kind: 'idempotency_key_violation',
        invariantName: inv.name,
        idempotencyKey: actionResult.idempotencyKey,
        firstResponse: { status: actionResult.status ?? 0, body: actionResult.responseBody },
        secondResponse: undefined,
      };
    case 'audit_log_missing_for_mutation':
      return {
        kind: 'audit_log_missing_for_mutation',
        invariantName: inv.name,
        expectedEntries: 1,
        foundEntries: Number(afterStore['count'] ?? 0),
      };
    case 'soft_delete_consistency':
      return {
        kind: 'soft_delete_consistency',
        invariantName: inv.name,
        queryResult: afterStore,
      };
  }
}

// ---------------------------------------------------------------------------
// Runtime context helpers
// ---------------------------------------------------------------------------

function buildRuntimeContext(tc: TestCase, actionResult: ActionResult | undefined, ctx: EvaluatorContext): Record<string, unknown> {
  return {
    currentUserId: ctx.role ?? '',
    responseId: actionResult?.responseBody !== null && typeof actionResult?.responseBody === 'object'
      ? String((actionResult.responseBody as Record<string, unknown>)['id'] ?? '')
      : '',
    sentAmount: 0,
    actionUrl: actionResult?.url ?? tc.page,
    actionResponseStatus: actionResult?.status ?? 0,
  };
}

function delay(ms: number): Promise<void> {
  type SetTimeoutFn = (fn: () => void, ms: number) => unknown;
  return new Promise(resolve => { (globalThis as unknown as { setTimeout: SetTimeoutFn }).setTimeout(resolve, ms); });
}
