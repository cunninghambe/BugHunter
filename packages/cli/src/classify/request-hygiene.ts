// Request hygiene classifiers — n_plus_one_api_calls, request_dedup_missing,
// request_cancellation_missing (§4.5–4.7).

import type { BugDetection } from '../types.js';
import type { HarLog, HarEntry } from '../adapters/har-writer.js';
import type { NavigationEvent } from '../adapters/cdp-session.js';
import { normalizePath } from './network.js';

const DEFAULT_N_PLUS_ONE_THRESHOLD = 8;
const DEDUP_WINDOW_MS = 100;

// --- N+1 detection (§4.5) ---

export function classifyNPlusOne(
  har: HarLog,
  nPlusOneThreshold = DEFAULT_N_PLUS_ONE_THRESHOLD,
): BugDetection[] {
  const detections: BugDetection[] = [];

  // Group entries by actionWindowId
  const byWindow = new Map<string, HarEntry[]>();
  for (const entry of har.log.entries) {
    const windowId = entry._bughunter.actionWindowId;
    const existing = byWindow.get(windowId);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      byWindow.set(windowId, [entry]);
    }
  }

  for (const [windowId, entries] of byWindow) {
    // Group by (method, normalizedPath)
    const groups = new Map<string, HarEntry[]>();
    for (const entry of entries) {
      const key = `${entry.request.method}|${normalizePath(entry.request.url)}`;
      const g = groups.get(key);
      if (g !== undefined) {
        g.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    for (const [key, group] of groups) {
      if (group.length < nPlusOneThreshold) continue;
      const [method, endpointFamily] = key.split('|') as [string, string];
      const exampleUrls = group.slice(0, 5).map(e => e.request.url);
      detections.push({
        kind: 'n_plus_one_api_calls',
        rootCause: `${method} ${endpointFamily} called ${group.length} times in one action window (threshold: ${nPlusOneThreshold})`,
        endpoint: `${method} ${endpointFamily}`,
        evidence: {
          method,
          endpointFamily,
          count: group.length,
          threshold: nPlusOneThreshold,
          exampleUrls,
          actionWindowId: windowId,
        },
      });
    }
  }

  return detections;
}

// --- Request dedup detection (§4.6) ---

export function classifyDedupMissing(har: HarLog): BugDetection[] {
  const detections: BugDetection[] = [];

  // Group by actionWindowId
  const byWindow = new Map<string, HarEntry[]>();
  for (const entry of har.log.entries) {
    const windowId = entry._bughunter.actionWindowId;
    const existing = byWindow.get(windowId);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      byWindow.set(windowId, [entry]);
    }
  }

  for (const [, entries] of byWindow) {
    // Group by (method, url, postData) — exact match
    const groups = new Map<string, HarEntry[]>();
    for (const entry of entries) {
      const bodyText = entry.request.postData?.text ?? '';
      const key = `${entry.request.method}|${entry.request.url}|${bodyText}`;
      const g = groups.get(key);
      if (g !== undefined) {
        g.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      // Sort by startedDateTime
      const sorted = [...group].sort((a, b) =>
        new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime()
      );

      const firstMs = new Date(sorted[0].startedDateTime).getTime();
      const lastMs = new Date(sorted[sorted.length - 1].startedDateTime).getTime();
      const windowMs = lastMs - firstMs;

      if (windowMs > DEDUP_WINDOW_MS) continue;

      detections.push({
        kind: 'request_dedup_missing',
        rootCause: `${sorted[0].request.method} ${sorted[0].request.url} issued ${group.length} times within ${windowMs}ms`,
        endpoint: `${sorted[0].request.method} ${normalizePath(sorted[0].request.url)}`,
        evidence: {
          method: sorted[0].request.method,
          url: sorted[0].request.url,
          duplicateCount: group.length,
          firstAtMs: firstMs,
          lastAtMs: lastMs,
          windowMs,
        },
      });
    }
  }

  return detections;
}

// --- Request cancellation detection (§4.7) ---

export function classifyCancelMissing(
  har: HarLog,
  navigationEvents: NavigationEvent[],
): BugDetection[] {
  if (navigationEvents.length < 2) return [];

  const detections: BugDetection[] = [];

  // For each navigation event (except the first), check if any requests were
  // in-flight at navigation time and completed after.
  for (let navIdx = 1; navIdx < navigationEvents.length; navIdx++) {
    const nav = navigationEvents[navIdx];
    const prevNav = navigationEvents[navIdx - 1];
    const navTimeMs = nav.timestamp;
    const prevNavTimeMs = prevNav.timestamp;

    for (const entry of har.log.entries) {
      const startMs = new Date(entry.startedDateTime).getTime();
      // Was the request started before this navigation?
      if (startMs < prevNavTimeMs || startMs >= navTimeMs) continue;
      // Did it complete after the navigation (response status is set and entry.time > 0)?
      const endMs = startMs + entry.time;
      if (endMs <= navTimeMs) continue;
      // The request completed after navigation — likely abandoned response
      if (entry.response.status === 0) continue; // failed requests don't count

      detections.push({
        kind: 'request_cancellation_missing',
        rootCause: `${entry.request.method} ${entry.request.url} was in-flight during navigation to ${nav.url}`,
        endpoint: `${entry.request.method} ${normalizePath(entry.request.url)}`,
        evidence: {
          method: entry.request.method,
          url: entry.request.url,
          startedBeforeNavAtMs: startMs,
          completedAfterNavAtMs: endMs,
          navigatedToUrl: nav.url,
        },
      });
    }
  }

  return detections;
}
