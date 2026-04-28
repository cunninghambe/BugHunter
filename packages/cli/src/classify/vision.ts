// Visual anomaly classifier — multimodal LLM pass over screenshots (§ 4, § 5).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { BugDetection, VisionConfig, VisionSeverity, VisionCategory } from '../types.js';
import type { VisionClientInterface } from '../adapters/vision-client.js';
import { VisionApiError } from '../adapters/vision-client.js';
import { log } from '../log.js';

export const MAX_DETECTIONS_PER_CALL = 5;
const MAX_DESCRIPTION_CHARS = 500;
const VISION_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// v1 prompt template — exported so tests can assert exact content.
export const VISION_PROMPT_TEMPLATE_V1 = `You are a senior front-end engineer reviewing a SaaS web app screenshot for visual defects.

CONTEXT:
- URL: {{url}}
- User role: {{role}}
- Action just taken: {{actionDescription}}

TASK:
Identify visual anomalies that a typical user would consider a bug. Focus on these categories:
- layout: overlapping elements, content cut off by viewport, sidebar/header rendered on top of main content, broken grid alignment, modal rendered as a full-page block, text wrapping breaking the layout
- content: missing labels, raw template strings (e.g. {{ }} or \${var}), placeholder text in production positions, wrong copy clearly inconsistent with the surrounding UI
- state: blank container where data is expected (a list area showing no rows when seed data should exist), infinite spinner (loading indicator visible with no data after the action), wrong-state UI (logged-in nav on a public page, "Save" button while form still says "Editing")
- error: visible error banner, "500 Internal Server Error", "Something went wrong" text, broken-image icons, stack traces leaking into the UI
- a11y: text in unreadably-low contrast, focus indicator missing on a clearly focused element

DO NOT report any of these:
- Loading states (spinners) by themselves — only report a spinner if the whole content area is a spinner with no data after a typical wait
- Intentional empty states with a clear message ("No trades yet — add one to get started")
- Minor pixel misalignment (1-2 px)
- Stylistic preferences (font choice, spacing, color palette) unless contrast is unreadable
- Anything you are uncertain about

SEVERITY GUIDE:
- critical: the page is unusable for its purpose (whole content blank; layout is shattered; clear error overlay)
- major: a primary feature is visibly broken (one section empty/broken while the rest of the page works; visible error banner; raw template string in a header)
- minor: cosmetic only — DO NOT REPORT THESE; if everything you see is minor, return an empty array

Return STRICT JSON, no prose, no markdown fences:
{
  "anomalies": [
    {
      "severity": "critical" | "major",
      "category": "layout" | "content" | "state" | "error" | "a11y" | "other",
      "element": "<concrete element reference, e.g. 'the trade-list table on the right side'>",
      "description": "<what is wrong, one sentence>",
      "suggestedFix": "<optional, one short sentence; omit if not obvious>"
    }
  ]
}

If there are no anomalies meeting the major/critical bar, return: {"anomalies": []}

EXAMPLES:

Example 1 (broken layout):
{
  "anomalies": [{
    "severity": "critical",
    "category": "layout",
    "element": "the entire main content area",
    "description": "The sidebar is rendered on top of the main content; trades table is fully obscured.",
    "suggestedFix": "Check sidebar z-index and the parent flex container."
  }]
}

Example 2 (state bug):
{
  "anomalies": [{
    "severity": "major",
    "category": "state",
    "element": "the trades table",
    "description": "The trades list area is empty with no empty-state message; expected at least one row given the dashboard shows '12 trades this week'."
  }]
}

Example 3 (no anomalies):
{"anomalies": []}`;

const VALID_SEVERITIES = new Set<string>(['minor', 'major', 'critical']);
const VALID_CATEGORIES = new Set<string>(['layout', 'content', 'state', 'error', 'a11y', 'other']);

type RawAnomaly = {
  severity?: unknown;
  category?: unknown;
  element?: unknown;
  description?: unknown;
  suggestedFix?: unknown;
};

export type ClassifyVisualInput = {
  screenshotPath: string;
  url: string;
  action: { kind: string; selector?: string };
  role: string;
  config?: VisionConfig;
  client: VisionClientInterface;
  /** Optional budget — when supplied, classifier records token usage for cost tracking. */
  budget?: { recordUsage(model: string, inputTokens: number, outputTokens: number): void };
};

export const DEFAULT_PRE_SCREENSHOT_SETTLE_MS = 2500;

export function resolveVisionConfig(c: VisionConfig | undefined, apiKey: string): {
  enabled: boolean;
  model: string;
  apiKey: string;
  maxCalls: number;
  maxCostUsd: number;
  concurrency: number;
  severityThreshold: VisionSeverity;
  preScreenshotSettleMs: number;
  consistencyRuns: number;
  agreementMode: 'strict' | 'majority';
} {
  return {
    enabled: c?.enabled ?? false,
    model: c?.model ?? DEFAULT_MODEL,
    apiKey,
    maxCalls: c?.maxCalls ?? 100,
    maxCostUsd: c?.maxCostUsd ?? 20,
    concurrency: c?.concurrency ?? 4,
    severityThreshold: c?.severityThreshold ?? 'major',
    preScreenshotSettleMs: c?.preScreenshotSettleMs ?? DEFAULT_PRE_SCREENSHOT_SETTLE_MS,
    consistencyRuns: c?.consistencyRuns ?? 2,
    agreementMode: c?.agreementMode ?? 'strict',
  };
}

export async function classifyVisualAnomalies(input: ClassifyVisualInput): Promise<BugDetection[]> {
  const threshold: VisionSeverity = input.config?.severityThreshold ?? 'major';
  const actionDescription = describeAction(input.action);

  const promptText = VISION_PROMPT_TEMPLATE_V1
    .replace('{{url}}', input.url)
    .replace('{{role}}', input.role)
    .replace('{{actionDescription}}', actionDescription);

  const callModel = input.config?.model ?? DEFAULT_MODEL;
  let rawText: string;
  try {
    const response = await input.client.classify({
      imagePath: input.screenshotPath,
      promptText,
      model: callModel,
      timeoutMs: VISION_CALL_TIMEOUT_MS,
    });
    rawText = response.rawText;
    if (response.usage !== undefined && input.budget !== undefined) {
      input.budget.recordUsage(callModel, response.usage.inputTokens, response.usage.outputTokens);
    }
  } catch (err) {
    if (err instanceof VisionApiError) {
      log.warn(`vision: API error (${err.kind})`, { message: err.message });
    } else {
      log.warn('vision: unexpected error', { message: String(err) });
    }
    return [];
  }

  const anomalies = parseVisionResponse(rawText, input.screenshotPath);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- parseVisionResponse always sets visualSeverity on returned anomalies
  return anomalies.filter(d => severityMeetsThreshold(d.visualSeverity!, threshold));
}

export function hashScreenshot(imagePath: string): string {
  const buf = fs.readFileSync(imagePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- v0.15: consistency aggregation ----

/**
 * Compute Jaccard similarity between two lowercased, whitespace-split token sets.
 * Returns 0 when both are empty to avoid false-positive matches.
 */
function elementJaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 0));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 0));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Returns true when two anomalies represent the same finding.
 * Matching criteria:
 *   - Same visualCategory (required in both modes)
 *   - Element Jaccard >= 0.5 on lowercased tokens (required in both modes)
 *   - Same visualSeverity (only in 'strict' mode)
 */
export function anomalyMatches(
  a: BugDetection,
  b: BugDetection,
  mode: 'strict' | 'majority',
): boolean {
  if (a.visualCategory !== b.visualCategory) return false;
  const elementA = a.rootCause.split(':')[0] ?? '';
  const elementB = b.rootCause.split(':')[0] ?? '';
  if (elementJaccard(elementA, elementB) < 0.5) return false;
  if (mode === 'strict' && a.visualSeverity !== b.visualSeverity) return false;
  return true;
}

export type AggregateConsistencyResult = {
  kept: BugDetection[];
  droppedByDisagreement: number;
  agreementRate: number;
};

/**
 * Aggregate N runs of vision results into a consistency-filtered list.
 *
 * Algorithm (per spec §4.3):
 *   1. Dedupe within each run (keep first occurrence by rootCause).
 *   2. For each anomaly in run-0, greedily match one anomaly per subsequent run.
 *   3. Cluster size = number of runs where a matching anomaly was found.
 *   4. Filter by mode: strict requires clusterSize === N; majority requires >= ceil(N/2).
 *   5. Canonical representation: run-0 occurrence; most-common severity (ties → max).
 */
export function aggregateConsistencyResults(
  results: BugDetection[][],
  mode: 'strict' | 'majority',
): AggregateConsistencyResult {
  const N = results.length;
  if (N === 0) return { kept: [], droppedByDisagreement: 0, agreementRate: 1 };

  // Dedupe within each run
  const runs = results.map(run => {
    const seen = new Set<string>();
    return run.filter(d => {
      if (seen.has(d.rootCause)) return false;
      seen.add(d.rootCause);
      return true;
    });
  });

  const run0 = runs[0] ?? [];
  if (run0.length === 0 && runs.every(r => r.length === 0)) {
    return { kept: [], droppedByDisagreement: 0, agreementRate: 1 };
  }

  const threshold = mode === 'strict' ? N : Math.ceil(N / 2);

  // For each anomaly in run-0, find matching anomalies in runs 1..N-1
  type ClusterEntry = { runIndex: number; detection: BugDetection };
  const clusters: ClusterEntry[][] = run0.map(d => [{ runIndex: 0, detection: d }]);

  for (let ri = 1; ri < N; ri++) {
    const remaining = [...(runs[ri] ?? [])];
    for (const cluster of clusters) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- clusters[ci] always has at least one entry (seeded from run-0)
      const canonical = cluster[0]!.detection;
      const matchIdx = remaining.findIndex(d => anomalyMatches(canonical, d, mode));
      if (matchIdx !== -1) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- matchIdx !== -1 guarantees element exists
        cluster.push({ runIndex: ri, detection: remaining[matchIdx]! });
        remaining.splice(matchIdx, 1);
      }
    }
  }

  const kept: BugDetection[] = [];
  let keptClusterSizeSum = 0;
  let allClusterSizeSum = 0;

  for (const cluster of clusters) {
    const clusterSize = cluster.length;
    allClusterSizeSum += clusterSize;

    if (clusterSize < threshold) continue;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- cluster always has at least one entry (seeded from run-0)
    const canonical = cluster[0]!.detection;

    // Choose most-common severity; ties → max
    const severityCounts: Partial<Record<VisionSeverity, number>> = {};
    for (const entry of cluster) {
      const sev = entry.detection.visualSeverity;
      if (sev !== undefined) {
        severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
      }
    }
    const severityOrder: Record<VisionSeverity, number> = { minor: 0, major: 1, critical: 2 };
    const chosenSeverity = (Object.entries(severityCounts) as Array<[VisionSeverity, number]>)
      .reduce<VisionSeverity | undefined>((best, [sev, count]) => {
        if (best === undefined) return sev;
        const bestCount = severityCounts[best] ?? 0;
        if (count > bestCount) return sev;
        if (count === bestCount && severityOrder[sev] > severityOrder[best]) return sev;
        return best;
      }, undefined);

    kept.push({ ...canonical, visualSeverity: chosenSeverity ?? canonical.visualSeverity });
    keptClusterSizeSum += clusterSize;
  }

  // droppedByDisagreement: anomalies seen in any run but NOT part of a kept cluster
  const totalSeen = runs.reduce((sum, r) => sum + r.length, 0);
  const droppedByDisagreement = totalSeen - keptClusterSizeSum;

  // agreementRate: average cluster-size / N for all run-0 anomalies (1.0 = perfect agreement)
  const agreementRate = clusters.length > 0
    ? allClusterSizeSum / (clusters.length * N)
    : 1;

  return { kept, droppedByDisagreement: Math.max(0, droppedByDisagreement), agreementRate };
}

export type ConsistentClassifyInput = ClassifyVisualInput & {
  consistencyRuns: number;
  agreementMode: 'strict' | 'majority';
};

export type ConsistentClassifyResult = {
  detections: BugDetection[];
  perRunDetections: BugDetection[][];
  callsAttempted: number;
  callsSucceeded: number;
  droppedByDisagreement: number;
  agreementRate: number;
};

/**
 * Run the vision classifier N times sequentially and aggregate results.
 * The caller is responsible for calling `visionBudget.tryConsume()` before
 * invoking this function (just as with the single-call path). Budget for
 * cost tracking (`recordUsage`) is forwarded to each inner call.
 * EC-1: when consistencyRuns === 1, equivalent to single-call behavior.
 */
export async function classifyVisualAnomaliesConsistent(
  input: ConsistentClassifyInput,
): Promise<ConsistentClassifyResult> {
  const { consistencyRuns, agreementMode, ...baseInput } = input;
  const perRun: BugDetection[][] = [];

  for (let i = 0; i < consistencyRuns; i++) {
    const dets = await classifyVisualAnomalies(baseInput);
    perRun.push(dets);
  }

  const { kept, droppedByDisagreement, agreementRate } = aggregateConsistencyResults(perRun, agreementMode);

  return {
    detections: kept,
    perRunDetections: perRun,
    callsAttempted: consistencyRuns,
    callsSucceeded: consistencyRuns,
    droppedByDisagreement,
    agreementRate,
  };
}

// ---- end v0.15 ----

function parseVisionResponse(rawText: string, screenshotPath: string): BugDetection[] {
  // Strip markdown fences if present
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    log.warn('vision: malformed response', { preview: rawText.slice(0, 200) });
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['anomalies'])) {
    log.warn('vision: malformed response structure', { preview: rawText.slice(0, 200) });
    return [];
  }

  const rawAnomalies = (parsed as { anomalies: RawAnomaly[] }).anomalies;

  const kept = rawAnomalies.slice(0, MAX_DETECTIONS_PER_CALL);
  const dropped = rawAnomalies.length - kept.length;
  if (dropped > 0) {
    log.info('vision: response truncated', { kept: MAX_DETECTIONS_PER_CALL, dropped });
  }

  const results: BugDetection[] = [];
  for (const anomaly of kept) {
    const severityRaw = String(anomaly.severity ?? '');
    if (!VALID_SEVERITIES.has(severityRaw)) continue; // drop invalid severity

    const severity = severityRaw as VisionSeverity;

    const categoryRaw = String(anomaly.category ?? '');
    const category: VisionCategory = VALID_CATEGORIES.has(categoryRaw)
      ? (categoryRaw as VisionCategory)
      : 'other';

    const description = String(anomaly.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
    const element = String(anomaly.element ?? '');
    const suggestedFix = (anomaly.suggestedFix !== undefined && anomaly.suggestedFix !== null) ? String(anomaly.suggestedFix) : undefined;

    const rootCause = element !== '' ? `${element}: ${description}` : description;

    results.push({
      kind: 'visual_anomaly',
      rootCause,
      visualCategory: category,
      visualSeverity: severity,
      visualSuggestedFix: suggestedFix,
      screenshotPath,
    });
  }

  return results;
}

function severityMeetsThreshold(severity: VisionSeverity, threshold: VisionSeverity): boolean {
  const order: Record<VisionSeverity, number> = { minor: 0, major: 1, critical: 2 };
  return order[severity] >= order[threshold];
}

function describeAction(action: { kind: string; selector?: string }): string {
  if (action.kind === 'render' || action.kind === 'navigate') {
    return 'the page rendered fresh on navigation; nothing has been clicked';
  }
  const selector = (action.selector !== undefined && action.selector !== '') ? ` on '${action.selector}'` : '';
  return `${action.kind}${selector}`;
}
