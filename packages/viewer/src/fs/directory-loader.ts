import { z } from 'zod';
import type { BugCluster, RunSummary } from '../types.ts';

// ---------------------------------------------------------------------------
// Public discriminated-union result type
// ---------------------------------------------------------------------------

export type DirectoryLoadResult =
  | { kind: 'idle' }
  | { kind: 'unsupported'; reason: 'no_fs_access_api' }
  | { kind: 'cancelled' }
  | { kind: 'denied'; reason: string }
  | { kind: 'loading' }
  | { kind: 'invalid'; reason: 'no_summary_json' | 'no_bugs_jsonl' | 'malformed_summary' }
  | { kind: 'loaded'; handle: FileSystemDirectoryHandle; runId: string; summary: RunSummary; clusters: BugCluster[] };

// ---------------------------------------------------------------------------
// Artifact types
// ---------------------------------------------------------------------------

export type ActionLogEntry = Record<string, unknown>;

export type HarFile = {
  log: {
    entries: Array<{
      request: { method: string; url: string };
      response: { status: number };
      time: number;
    }>;
  };
};

// ---------------------------------------------------------------------------
// Zod schema for BugCluster — validates each bugs.jsonl line.
// We only check the fields the viewer renders; extra fields are allowed.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

export async function pickRunDirectory(): Promise<DirectoryLoadResult> {
  if (!('showDirectoryPicker' in window)) {
    return { kind: 'unsupported', reason: 'no_fs_access_api' };
  }

  // The FS Access API is not in TypeScript's lib by default; cast to access it.
  type ShowDirPicker = (opts: { mode: string; id: string; startIn: string }) => Promise<FileSystemDirectoryHandle>;
  const showDirectoryPicker = (window as unknown as { showDirectoryPicker: ShowDirPicker }).showDirectoryPicker;

  let handle: FileSystemDirectoryHandle;
  try {
    handle = await showDirectoryPicker({ mode: 'read', id: 'bughunter-run', startIn: 'documents' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'cancelled' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'denied', reason };
  }

  return loadFromHandle(handle);
}

export async function loadFromHandle(handle: FileSystemDirectoryHandle): Promise<DirectoryLoadResult> {
  // 1. summary.json
  let summaryText: string;
  try {
    const summaryHandle = await handle.getFileHandle('summary.json');
    const summaryFile = await summaryHandle.getFile();
    summaryText = await summaryFile.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return { kind: 'invalid', reason: 'no_summary_json' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'denied', reason };
  }

  let summary: RunSummary;
  try {
    summary = JSON.parse(summaryText) as RunSummary;
  } catch {
    return { kind: 'invalid', reason: 'malformed_summary' };
  }

  // 2. bugs.jsonl
  let bugsText: string;
  try {
    const bugsHandle = await handle.getFileHandle('bugs.jsonl');
    const bugsFile = await bugsHandle.getFile();
    bugsText = await bugsFile.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return { kind: 'invalid', reason: 'no_bugs_jsonl' };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'denied', reason };
  }

  // 3. Parse bugs.jsonl line-by-line
  const clusters: BugCluster[] = [];
  const lines = bugsText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    parseLine(trimmed, clusters, summary.runId);
  }

  return { kind: 'loaded', handle, runId: summary.runId, summary, clusters };
}

function parseLine(line: string, clusters: BugCluster[], expectedRunId: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // EC-1: malformed line — skip
    console.warn('[viewer] Skipping malformed bugs.jsonl line (JSON parse error)');
    return;
  }

  const parsed = bugClusterSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[viewer] Skipping malformed bugs.jsonl line (schema validation failed)', parsed.error.issues);
    return;
  }

  const cluster = parsed.data as BugCluster;

  // EC-11: runId mismatch
  if (cluster.runId !== expectedRunId) {
    console.warn('[viewer] Skipping cluster with mismatched runId', { clusterId: cluster.id, clusterRunId: cluster.runId, expectedRunId });
    return;
  }

  clusters.push(cluster);
}

// ---------------------------------------------------------------------------
// Lazy artifact loading
// ---------------------------------------------------------------------------

export async function loadOccurrenceArtifacts(
  rootHandle: FileSystemDirectoryHandle,
  occurrenceId: string,
): Promise<{
  screenshot?: Blob;
  actionLog?: ActionLogEntry[];
  consoleLog?: string;
  networkLog?: HarFile;
}> {
  const result: {
    screenshot?: Blob;
    actionLog?: ActionLogEntry[];
    consoleLog?: string;
    networkLog?: HarFile;
  } = {};

  // Screenshot
  try {
    const screenshotsDir = await rootHandle.getDirectoryHandle('screenshots');
    const file = await screenshotsDir.getFileHandle(`${occurrenceId}.png`);
    result.screenshot = await (await file.getFile()).arrayBuffer().then(buf => new Blob([buf], { type: 'image/png' }));
  } catch {
    // EC-2: screenshot missing — not a blocking error
  }

  // Action log
  try {
    const actionLogsDir = await rootHandle.getDirectoryHandle('action-logs');
    const file = await actionLogsDir.getFileHandle(`${occurrenceId}.json`);
    const text = await (await file.getFile()).text();
    result.actionLog = JSON.parse(text) as ActionLogEntry[];
  } catch {
    // Missing action log — not a blocking error
  }

  // Console log
  try {
    const consoleDir = await rootHandle.getDirectoryHandle('console');
    const file = await consoleDir.getFileHandle(`${occurrenceId}.log`);
    result.consoleLog = await (await file.getFile()).text();
  } catch {
    // Missing console log — not a blocking error
  }

  // Network (HAR)
  try {
    const networkDir = await rootHandle.getDirectoryHandle('network');
    const file = await networkDir.getFileHandle(`${occurrenceId}.har`);
    const text = await (await file.getFile()).text();
    result.networkLog = JSON.parse(text) as HarFile;
  } catch {
    // Missing network log — not a blocking error
  }

  return result;
}

// ---------------------------------------------------------------------------
// IndexedDB persistence of FileSystemDirectoryHandle
// ---------------------------------------------------------------------------

const IDB_NAME = 'bughunter-viewer';
const IDB_STORE = 'handles';
const IDB_KEY = 'lastDirectoryHandle';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persistHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(handle, IDB_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadPersistedHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (handle === null) return null;
    // queryPermission is part of the FS Access API but not in TypeScript's lib.
    type HandleWithPerm = FileSystemDirectoryHandle & {
      queryPermission: (opts: { mode: string }) => Promise<string>;
    };
    const perm = await (handle as HandleWithPerm).queryPermission({ mode: 'read' });
    if (perm === 'granted') return handle;
    return handle; // Caller can call requestPermission if prompt
  } catch {
    return null;
  }
}

export async function clearPersistedHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.delete(IDB_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-fatal
  }
}
