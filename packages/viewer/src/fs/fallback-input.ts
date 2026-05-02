import { z } from 'zod';
import type { BugCluster, RunSummary } from '../types.ts';

// A minimal shim exposing the same surface as FileSystemDirectoryHandle,
// built from the FileList delivered by <input webkitdirectory>.

export type FallbackDirectoryResult =
  | { kind: 'cancelled' }
  | { kind: 'invalid'; reason: 'no_summary_json' | 'no_bugs_jsonl' | 'malformed_summary' }
  | { kind: 'loaded'; runId: string; summary: RunSummary; clusters: BugCluster[] };

type FileMap = Map<string, File>;

// Zod schema mirrors directory-loader's schema.
const bugClusterSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  rootCause: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  clusterSize: z.number(),
  occurrences: z.array(z.object({
    occurrenceId: z.string(),
    role: z.string(),
    page: z.string(),
    fullArtifacts: z.boolean(),
  }).passthrough()),
  suspectedFiles: z.array(z.string()),
  fixHints: z.array(z.string()),
  thirdPartyOrGenerated: z.boolean(),
}).passthrough();

function buildFileMap(fileList: FileList): FileMap {
  const map: FileMap = new Map();
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (file === undefined) continue;
    // webkitRelativePath is like "runId/bugs.jsonl" — strip the leading dir component.
    const parts = file.webkitRelativePath.split('/');
    // Keep everything after the first segment (the root directory name).
    const relativePath = parts.slice(1).join('/');
    if (relativePath !== '') {
      map.set(relativePath, file);
    }
  }
  return map;
}

function parseBugsJsonl(text: string, expectedRunId: string): BugCluster[] {
  const clusters: BugCluster[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      console.warn('[viewer/fallback] Skipping malformed bugs.jsonl line');
      continue;
    }
    const parsed = bugClusterSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[viewer/fallback] Skipping invalid cluster line', parsed.error.issues);
      continue;
    }
    const cluster = parsed.data as BugCluster;
    if (cluster.runId !== expectedRunId) {
      console.warn('[viewer/fallback] Skipping cluster with mismatched runId');
      continue;
    }
    clusters.push(cluster);
  }
  return clusters;
}

export async function loadFromFileList(fileList: FileList): Promise<FallbackDirectoryResult> {
  if (fileList.length === 0) {
    return { kind: 'cancelled' };
  }

  const map = buildFileMap(fileList);

  const summaryFile = map.get('summary.json');
  if (summaryFile === undefined) {
    return { kind: 'invalid', reason: 'no_summary_json' };
  }

  let summary: RunSummary;
  try {
    summary = JSON.parse(await summaryFile.text()) as RunSummary;
  } catch {
    return { kind: 'invalid', reason: 'malformed_summary' };
  }

  const bugsFile = map.get('bugs.jsonl');
  if (bugsFile === undefined) {
    return { kind: 'invalid', reason: 'no_bugs_jsonl' };
  }

  const bugsText = await bugsFile.text();
  const clusters = parseBugsJsonl(bugsText, summary.runId);

  return { kind: 'loaded', runId: summary.runId, summary, clusters };
}
