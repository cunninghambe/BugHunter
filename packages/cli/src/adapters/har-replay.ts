// HAR-based network record/replay adapter for --frozen-network / --record-network.
//
// Replay mode: intercepts every outbound HTTP request; matches against recorded
// HAR entries by (method, normalizedUrl, normalizedBody).  Miss = hard-fail by
// default; use --allow-network-miss to fall through to live network.
//
// Record mode: live network is allowed; HAR is written at run-end.
//
// Sensitive-header redaction: Authorization + anthropic-organization-id are
// replaced with "***REDACTED***" before writing HAR (OQ-3 conservative).
//
// OQ-9: SurfaceMCP localhost requests are captured in the HAR just like
// any other outbound call.

import * as fs from 'node:fs';
import type { HarEntry, HarLog } from './har-writer.js';

export type NetworkMode =
  | { kind: 'live' }
  | { kind: 'record'; harPath: string }
  | { kind: 'replay'; harPath: string; allowMiss: boolean };

export type ReplayMatchResult =
  | { matched: true; entry: HarEntry }
  | { matched: false };

const REDACTED_HEADERS = new Set(['authorization', 'anthropic-organization-id']);

export type HarReplayer = {
  /** Match a request to a recorded entry.  Returns undefined on miss. */
  match(req: { method: string; url: string; body?: string }): HarEntry | undefined;
  /** Total number of entries in the HAR. */
  size(): number;
  /** Entries not yet matched during this replay session. */
  unmatched(): HarEntry[];
  /** Telemetry counters. */
  telemetry(): { matched: number; missed: number; unmatchedRecorded: number };
};

/**
 * Parse a HAR file from disk.
 * Throws with a clear error on parse failure (EC-3).
 */
export function loadHar(harPath: string): HarLog {
  let raw: string;
  try {
    raw = fs.readFileSync(harPath, 'utf-8');
  } catch {
    throw new Error(`--frozen-network: file not found: ${harPath}`);
  }
  try {
    return JSON.parse(raw) as HarLog;
  } catch {
    throw new Error(`--frozen-network: HAR file is not valid JSON: ${harPath}`);
  }
}

/**
 * Load an optional normalization config (strips query params from the match key).
 * Returns empty config when the sibling file does not exist.
 */
export function loadNormalizeConfig(harPath: string): { stripQueryParams: string[] } {
  const configPath = `${harPath}.normalize.json`;
  if (!fs.existsSync(configPath)) return { stripQueryParams: [] };
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { stripQueryParams: string[] };
  } catch {
    return { stripQueryParams: [] };
  }
}

/**
 * Construct a HarReplayer from a parsed HAR log.
 * Tracks matched/unmatched counters for end-of-run audit.
 */
export function makeHarReplayer(har: HarLog, normalizeConfig: { stripQueryParams: string[] }): HarReplayer {
  const entries = har.log.entries;
  const matchedEntryIndices = new Set<number>();
  let matchedCount = 0;
  let missedCount = 0;

  return {
    match(req) {
      const reqKey = buildMatchKey(req.method, req.url, req.body, normalizeConfig.stripQueryParams);
      for (let i = 0; i < entries.length; i++) {
        if (matchedEntryIndices.has(i)) continue;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- entries[i] always defined within bounds
        const entry = entries[i]!;
        const entryKey = buildMatchKey(
          entry.request.method,
          entry.request.url,
          entry.request.postData?.text,
          normalizeConfig.stripQueryParams,
        );
        if (reqKey === entryKey) {
          matchedEntryIndices.add(i);
          matchedCount++;
          return entry;
        }
      }
      missedCount++;
      return undefined;
    },
    size() {
      return entries.length;
    },
    unmatched() {
      return entries.filter((_, i) => !matchedEntryIndices.has(i));
    },
    telemetry() {
      return {
        matched: matchedCount,
        missed: missedCount,
        unmatchedRecorded: entries.length - matchedEntryIndices.size,
      };
    },
  };
}

/**
 * Build the canonical match key for a request.
 * Key: "<METHOD> <normalizedUrl>[ <normalizedBody>]"
 * stripQueryParams: remove these query-parameter names before comparison.
 * Body normalization: stringified JSON with sorted keys (or raw string if not JSON).
 */
export function buildMatchKey(
  method: string,
  url: string,
  body: string | undefined,
  stripQueryParams: string[],
): string {
  const normalizedUrl = normalizeUrl(url, stripQueryParams);
  const normalizedBody = body !== undefined ? normalizeBody(body) : '';
  const bodyPart = normalizedBody !== '' ? ` ${normalizedBody}` : '';
  return `${method.toUpperCase()} ${normalizedUrl}${bodyPart}`;
}

function normalizeUrl(rawUrl: string, stripQueryParams: string[]): string {
  try {
    const u = new URL(rawUrl);
    for (const param of stripQueryParams) {
      u.searchParams.delete(param);
    }
    // Stable sort remaining params
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of params) {
      u.searchParams.append(k, v);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    return JSON.stringify(sortKeysDeep(parsed));
  } catch {
    return body;
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Redact sensitive headers in a HAR entry before writing to disk.
 * Returns a new entry — does not mutate the original.
 */
export function redactHarEntry(entry: HarEntry): HarEntry {
  return {
    ...entry,
    request: {
      ...entry.request,
      headers: entry.request.headers.map(h =>
        REDACTED_HEADERS.has(h.name.toLowerCase())
          ? { name: h.name, value: '***REDACTED***' }
          : h,
      ),
    },
  };
}

/**
 * Write a HAR log to disk with Authorization and org-id headers redacted.
 * Called at run-end when --record-network is active.
 */
export function writeRecordedHar(harPath: string, entries: HarEntry[]): void {
  const har: HarLog = {
    log: {
      version: '1.2',
      creator: { name: 'bughunter', version: '0.32.0' },
      entries: entries.map(redactHarEntry),
    },
  };
  fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
}
