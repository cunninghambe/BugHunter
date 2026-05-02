// v0.42: per-BugKind detection builder for data-integrity invariant violations.

import type { BugDetection, DataIntegrityExtra, DataIntegrityInvariant, TestCase } from '../types.js';

export type ActionResult = {
  status?: number;
  method?: string;
  url?: string;
  responseBody?: unknown;
  requestBody?: unknown;
  requestHeaders?: Record<string, string>;
  idempotencyKey?: string;
};

/**
 * Build a BugDetection for a data-integrity invariant violation.
 * The extra payload shape is discriminated on bugKind.
 */
export function buildDataIntegrityDetection(
  inv: DataIntegrityInvariant,
  tc: TestCase,
  actionResult: ActionResult,
  extra: DataIntegrityExtra,
): BugDetection {
  return {
    kind: inv.bugKind,
    rootCause: buildRootCause(inv, tc, actionResult),
    endpoint: actionResult.url ?? tc.page,
    status: actionResult.status,
    pageRoute: tc.page,
    triggeringAction: tc.action,
    dataIntegrityContext: extra,
  };
}

function buildRootCause(inv: DataIntegrityInvariant, tc: TestCase, result: ActionResult): string {
  const method = result.method ?? (tc.action.via === 'ui' ? 'UI' : 'API');
  const url = result.url ?? tc.page;
  switch (inv.bugKind) {
    case 'data_integrity_orphan':
      return `data_integrity_orphan: orphaned rows found after ${method} ${url} (invariant: ${inv.name})`;
    case 'money_math_precision':
      return `money_math_precision: stored value disagrees beyond tolerance after ${method} ${url} (invariant: ${inv.name})`;
    case 'cache_staleness':
      return `cache_staleness: read-after-write returned stale value after ${method} ${url} (invariant: ${inv.name})`;
    case 'idempotency_key_violation':
      return `idempotency_key_violation: replay produced different result for ${method} ${url} (invariant: ${inv.name})`;
    case 'audit_log_missing_for_mutation':
      return `audit_log_missing_for_mutation: no audit entry found after ${method} ${url} (invariant: ${inv.name})`;
    case 'soft_delete_consistency':
      return `soft_delete_consistency: consistency violated after ${method} ${url} (invariant: ${inv.name})`;
  }
}
