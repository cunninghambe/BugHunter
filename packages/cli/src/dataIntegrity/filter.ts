// v0.42: filter invariants against an action's properties.

import type { DataIntegrityInvariant, TestCase } from '../types.js';

/**
 * Returns invariants whose appliesTo filter matches the test case.
 * All defined filter fields must match (AND semantics).
 */
export function filterInvariants(
  invariants: DataIntegrityInvariant[],
  tc: TestCase,
): DataIntegrityInvariant[] {
  return invariants.filter(inv => matchesFilter(inv, tc));
}

function matchesFilter(inv: DataIntegrityInvariant, tc: TestCase): boolean {
  const { appliesTo } = inv;

  if (appliesTo.actionIds !== undefined && appliesTo.actionIds.length > 0) {
    return appliesTo.actionIds.includes(tc.id);
  }

  if (appliesTo.method !== undefined) {
    const methods = Array.isArray(appliesTo.method) ? appliesTo.method : [appliesTo.method];
    const actionMethod = actionHttpMethod(tc);
    if (actionMethod === undefined || !methods.includes(actionMethod)) return false;
  }

  if (appliesTo.urlPattern !== undefined) {
    const pattern = new RegExp(appliesTo.urlPattern);
    const url = actionUrl(tc);
    if (url === undefined || !pattern.test(url)) return false;
  }

  if (appliesTo.palette !== undefined) {
    const palettes = Array.isArray(appliesTo.palette) ? appliesTo.palette : [appliesTo.palette];
    if (!palettes.includes(tc.palette)) return false;
  }

  return true;
}

function actionHttpMethod(tc: TestCase): string | undefined {
  // UI actions (via === 'ui') are treated as POST/mutating without a specific HTTP method.
  // We can't filter by HTTP method for UI actions; skip method filter for them.
  if (tc.action.via === 'ui') return undefined;
  return 'POST'; // API direct calls are POST by convention; toolId resolves at execute time
}

function actionUrl(tc: TestCase): string | undefined {
  return tc.page !== '' ? tc.page : undefined;
}
