// v0.45 read-only mode — canonical predicates and error class.
// Single source of truth for "is this tool/action read-only?".

import type { Action, ToolMeta } from '../types.js';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type ToolReadOnlyAttrs = { method: string; sideEffectClass: string | undefined };

/**
 * Returns true when the tool is provably read-only: its HTTP method is
 * GET/HEAD/OPTIONS AND SurfaceMCP has classified it as 'safe'.
 * A GET endpoint classified as 'mutating' (e.g. GET /api/users/delete?id=1)
 * still returns false.
 */
export function isReadOnlyTool(tool: ToolReadOnlyAttrs | Pick<ToolMeta, 'method' | 'sideEffectClass'>): boolean {
  return READ_ONLY_METHODS.has(tool.method) && tool.sideEffectClass === 'safe';
}

/**
 * Returns true when the action is provably read-only.
 * render and navigate are always read-only (no API call issued).
 * click with no resolved toolId is conservatively treated as mutating.
 * All other kinds require the resolved tool to satisfy isReadOnlyTool.
 */
export function isReadOnlyAction(
  action: Action,
  toolCatalog: Map<string, Pick<ToolMeta, 'method' | 'sideEffectClass'>>,
): boolean {
  if (action.kind === 'render' || action.kind === 'navigate') return true;

  const toolId = 'toolId' in action ? action.toolId : undefined;
  if (toolId === undefined) return false;

  const tool = toolCatalog.get(toolId);
  if (tool === undefined) return false;

  return isReadOnlyTool(tool);
}

/**
 * Thrown by Tier 3 runtime guard when a mutating action reaches an executor
 * while readOnly === true. Fatal: indicates a Tier 2 gating gap.
 */
export class MutatingActionRejectedError extends Error {
  readonly code = 'MUTATING_ACTION_REJECTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MutatingActionRejectedError';
  }
}
