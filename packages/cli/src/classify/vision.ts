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
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

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
};

export function resolveVisionConfig(c: VisionConfig | undefined, apiKey: string): {
  enabled: boolean;
  model: string;
  apiKey: string;
  maxCalls: number;
  concurrency: number;
  severityThreshold: VisionSeverity;
} {
  return {
    enabled: c?.enabled ?? false,
    model: c?.model ?? DEFAULT_MODEL,
    apiKey,
    maxCalls: c?.maxCalls ?? 100,
    concurrency: c?.concurrency ?? 4,
    severityThreshold: c?.severityThreshold ?? 'major',
  };
}

export async function classifyVisualAnomalies(input: ClassifyVisualInput): Promise<BugDetection[]> {
  const threshold: VisionSeverity = input.config?.severityThreshold ?? 'major';
  const actionDescription = describeAction(input.action);

  const promptText = VISION_PROMPT_TEMPLATE_V1
    .replace('{{url}}', input.url)
    .replace('{{role}}', input.role)
    .replace('{{actionDescription}}', actionDescription);

  let rawText: string;
  try {
    const response = await input.client.classify({
      imagePath: input.screenshotPath,
      promptText,
      model: input.config?.model ?? DEFAULT_MODEL,
      timeoutMs: VISION_CALL_TIMEOUT_MS,
    });
    rawText = response.rawText;
  } catch (err) {
    if (err instanceof VisionApiError) {
      log.warn(`vision: API error (${err.kind})`, { message: err.message });
    } else {
      log.warn('vision: unexpected error', { message: String(err) });
    }
    return [];
  }

  const anomalies = parseVisionResponse(rawText, input.screenshotPath);
  return anomalies.filter(d => severityMeetsThreshold(d.visualSeverity!, threshold));
}

export function hashScreenshot(imagePath: string): string {
  const buf = fs.readFileSync(imagePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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

  let kept = rawAnomalies.slice(0, MAX_DETECTIONS_PER_CALL);
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
    const suggestedFix = anomaly.suggestedFix ? String(anomaly.suggestedFix) : undefined;

    const rootCause = element ? `${element}: ${description}` : description;

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
  const selector = action.selector ? ` on '${action.selector}'` : '';
  return `${action.kind}${selector}`;
}
