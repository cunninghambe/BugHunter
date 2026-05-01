// Cursor encode/decode for stateless pagination across bugs.jsonl.
// Cursors are opaque base64url-encoded JSON blobs; the filterHash guards
// against callers changing filter args between pages.

import { createHash } from 'node:crypto';

type CursorPayload = {
  offset: number;
  runId: string;
  filterHash: string;
};

type FilterArgs = {
  kind?: string | string[];
  role?: string;
  routePattern?: string;
  verdict?: string;
  severity?: string;
  minClusterSize?: number;
};

export function computeFilterHash(filters: FilterArgs): string {
  const stable = JSON.stringify({
    kind: filters.kind,
    minClusterSize: filters.minClusterSize,
    role: filters.role,
    routePattern: filters.routePattern,
    severity: filters.severity,
    verdict: filters.verdict,
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
  } catch {
    throw new Error('invalid cursor: not valid base64url JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['offset'] !== 'number' ||
    typeof (parsed as Record<string, unknown>)['runId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['filterHash'] !== 'string'
  ) {
    throw new Error('invalid cursor: missing required fields');
  }
  return parsed as CursorPayload;
}
