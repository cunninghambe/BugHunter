// Phase: analyze — heap-snapshot capture + diffing for memory_leak_attributed.
// Runs between cluster and emit when:
//   (a) memory_leak_suspected cluster exists in the run, OR
//   (b) config.perf.heapAttribution === true
// Spec: §4 of SPEC_V08_MEMORY_LEAK.md

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { BugCluster, BugDetection, BugHunterConfig, HeapSnapshotRaw } from '../types.js';
import type { CdpSession } from '../adapters/cdp-session.js';
import { V8HeapSnapshotDiff, HeapDiffError } from '../analyze/heap-diff.js';
import type { HeapSnapshotDiff } from '../analyze/heap-diff.js';
import { log } from '../log.js';

export type AnalyzeOptions = {
  clusters: BugCluster[];
  cdpSession: CdpSession;
  heapDir: string;
  config: BugHunterConfig;
  actionCount: number;
};

export type AnalyzeResult =
  | { ok: true; detections: BugDetection[]; snapshotsCaptured: number; diffsRun: number }
  | { ok: false; reason: string };

const EXCLUDED_RETAINER_ROOTS = new Set([
  'Window', 'Document', '(Module)', 'FiberRoot',
]);

function hasSuspectedLeak(clusters: BugCluster[]): boolean {
  return clusters.some(c => c.kind === 'memory_leak_suspected');
}

function shouldRunAnalyze(clusters: BugCluster[], config: BugHunterConfig): boolean {
  return (config.perf?.heapAttribution === true) || hasSuspectedLeak(clusters);
}

function snapshotActionIndices(actionCount: number, frequency: 'auto' | number): number[] {
  if (actionCount < 3) return [];
  if (frequency === 'auto') {
    const mid = Math.floor(actionCount / 2);
    return [...new Set([0, mid, actionCount - 1])];
  }
  const indices: number[] = [];
  for (let i = 0; i < actionCount; i += frequency) {
    indices.push(i);
  }
  if (indices[indices.length - 1] !== actionCount - 1) {
    indices.push(actionCount - 1);
  }
  return indices;
}

async function captureSnapshot(
  cdpSession: CdpSession,
  actionIdx: number,
  heapDir: string,
): Promise<HeapSnapshotRaw | null> {
  try {
    await cdpSession.collectGarbage();
    const snapshot = await cdpSession.takeHeapSnapshot();

    const gzipped = zlib.gzipSync(Buffer.from(snapshot.json, 'utf-8'));
    const filePath = path.join(heapDir, `snapshot-${actionIdx}.json.gz`);
    fs.writeFileSync(filePath, gzipped);
    log.debug('analyze: heap snapshot captured', { actionIdx, bytes: gzipped.length });

    return snapshot;
  } catch (err) {
    log.warn('analyze: snapshot capture failed', { actionIdx, err: String(err) });
    return null;
  }
}

function buildDetections(
  diff: HeapSnapshotDiff,
  minInstances: number,
  minBytes: number,
): BugDetection[] {
  const detections: BugDetection[] = [];

  for (const entry of diff.growthByConstructor) {
    if (entry.instanceCountDelta < minInstances && entry.retainedSizeDelta < minBytes) continue;
    if (entry.retainerChain.length === 0) continue;
    if (entry.retainerChain.every(f => EXCLUDED_RETAINER_ROOTS.has(f))) continue;

    const isStdlib = isStdlibConstructor(entry.constructorName);
    const confidence = (!isStdlib && entry.retainerChain.length >= 2) ? 'high' : 'medium';

    detections.push({
      kind: 'memory_leak_attributed',
      rootCause: buildRootCause(entry),
      heapContext: {
        constructorName: entry.constructorName,
        instanceCountDelta: entry.instanceCountDelta,
        retainedSizeDelta: entry.retainedSizeDelta,
        retainerChain: entry.retainerChain,
        diffWindow: {
          beforeActionIdx: diff.beforeIdx,
          afterActionIdx: diff.afterIdx,
        },
        ...(diff.largeTimeGap ? { largeTimeGap: true } : {}),
      },
      evidence: { confidence },
    });
  }

  return detections;
}

function isStdlibConstructor(name: string): boolean {
  return /^HTML|^SVG|^CSS|^Element$|^Node$|^Event$|^Object$|^Array$/.test(name);
}

function buildRootCause(entry: { constructorName: string; instanceCountDelta: number; retainedSizeDelta: number; retainerChain: string[] }): string {
  const kb = Math.round(entry.retainedSizeDelta / 1024);
  const chain = entry.retainerChain.slice(0, 3).join(' → ');
  return `Heap growth: ${entry.constructorName} grew by ${entry.instanceCountDelta} instances (+${kb}KB retained); retainer chain: ${chain}`;
}

function pruneOldSnapshots(heapDir: string, keepIndices: number[]): void {
  const keepSet = new Set(keepIndices.map(i => `snapshot-${i}.json.gz`));
  try {
    // v0.32: sort ASC for deterministic snapshot file traversal order.
    for (const file of fs.readdirSync(heapDir).sort()) {
      if (file.startsWith('snapshot-') && file.endsWith('.json.gz') && !keepSet.has(file)) {
        fs.unlinkSync(path.join(heapDir, file));
      }
    }
  } catch {
    // Best-effort pruning; never fatal.
  }
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<AnalyzeResult> {
  const { clusters, cdpSession, heapDir, config, actionCount } = opts;

  if (!shouldRunAnalyze(clusters, config)) {
    return { ok: true, detections: [], snapshotsCaptured: 0, diffsRun: 0 };
  }

  fs.mkdirSync(heapDir, { recursive: true });

  const frequency = config.perf?.heapSnapshotFrequency ?? 'auto';
  const indices = snapshotActionIndices(actionCount, frequency);

  if (indices.length < 2) {
    log.info('analyze: not enough action indices for snapshot diff', { actionCount });
    return { ok: true, detections: [], snapshotsCaptured: 0, diffsRun: 0 };
  }

  // Capture snapshots at configured indices.
  const snapshots = new Map<number, HeapSnapshotRaw>();
  for (const idx of indices) {
    const snapshot = await captureSnapshot(cdpSession, idx, heapDir);
    if (snapshot !== null) snapshots.set(idx, snapshot);
  }

  const captured = snapshots.size;
  if (captured < 2) {
    log.warn('analyze: fewer than 2 snapshots captured; skipping diff');
    return { ok: true, detections: [], snapshotsCaptured: captured, diffsRun: 0 };
  }

  const minInstances = config.perf?.heapDiffMinInstances ?? 10;
  const minBytes = config.perf?.heapDiffMinBytes ?? 5_000_000;
  const differ = new V8HeapSnapshotDiff();
  const allDetections: BugDetection[] = [];
  let diffsRun = 0;

  const sortedIndices = [...snapshots.keys()].sort((a, b) => a - b);

  for (let i = 0; i < sortedIndices.length - 1; i++) {
    const beforeIdx = sortedIndices[i] ?? 0;
    const afterIdx = sortedIndices[i + 1] ?? 0;
    const beforeSnap = snapshots.get(beforeIdx);
    const afterSnap = snapshots.get(afterIdx);
    if (beforeSnap === undefined || afterSnap === undefined) continue;

    try {
      const diff = differ.diff(beforeSnap, afterSnap, {
        beforeIdx,
        afterIdx,
        minInstanceDelta: minInstances,
        minRetainedDelta: minBytes,
      });
      diffsRun++;
      const detections = buildDetections(diff, minInstances, minBytes);
      allDetections.push(...detections);
      log.debug('analyze: diff complete', {
        beforeIdx,
        afterIdx,
        growthEntries: diff.growthByConstructor.length,
        detections: detections.length,
      });
    } catch (err) {
      if (err instanceof HeapDiffError) {
        log.warn('analyze: heap diff parse failed', { beforeIdx, afterIdx, reason: err.message });
      } else {
        log.warn('analyze: heap diff unexpected error', { beforeIdx, afterIdx, err: String(err) });
      }
    }
  }

  // Keep only the last 3 snapshot files; prune older ones.
  const keepIndices = sortedIndices.slice(-3);
  pruneOldSnapshots(heapDir, keepIndices);

  return { ok: true, detections: allDetections, snapshotsCaptured: captured, diffsRun };
}
