// analyze/heap-diff.ts — V8 heap-snapshot diffing for memory_leak_attributed.
// Parses the V8 heap-snapshot JSON format inline (no external deps).
// Spec: §4 of SPEC_V08_MEMORY_LEAK.md

import type { HeapSnapshotRaw } from '../types.js';

export type HeapDiffEntry = {
  constructorName: string;
  instanceCountBefore: number;
  instanceCountAfter: number;
  instanceCountDelta: number;
  retainedSizeBefore: number;
  retainedSizeAfter: number;
  retainedSizeDelta: number;
  /** Top 3 retainer-chain frames; empty if no chain found */
  retainerChain: string[];
};

export type HeapSnapshotDiff = {
  beforeIdx: number;
  afterIdx: number;
  capturedAtMsBefore: number;
  capturedAtMsAfter: number;
  /** Sorted by retainedSizeDelta DESC */
  growthByConstructor: HeapDiffEntry[];
  /** True when snapshots are >5 min apart */
  largeTimeGap: boolean;
};

export class HeapDiffError extends Error {
  constructor(public readonly code: 'parse_failed', message: string) {
    super(message);
    this.name = 'HeapDiffError';
  }
}

export interface HeapDiffInterface {
  diff(
    beforeRaw: HeapSnapshotRaw,
    afterRaw: HeapSnapshotRaw,
    opts?: DiffOptions,
  ): HeapSnapshotDiff;
}

export type DiffOptions = {
  beforeIdx?: number;
  afterIdx?: number;
  minInstanceDelta?: number;
  minRetainedDelta?: number;
};

// Constructors too generic to action — filtered from results.
const GENERIC_CONSTRUCTORS = new Set([
  '(Object)', '(Array)', '(Map)', '(Set)', '(WeakMap)', '(WeakSet)',
  '(closure)', 'Window', 'Document',
]);

// Constructors excluded from retainer chains (expected singletons / framework roots).
const EXCLUDED_RETAINER_ROOTS = new Set([
  'Window', 'Document', '(Module)', 'FiberRoot',
]);

// V8 snapshot node field indices (from the snapshot meta).
const NODE_TYPE_OFFSET = 0;
const NODE_NAME_OFFSET = 1;
const NODE_RETAINED_SIZE_OFFSET = 3;
const NODE_EDGES_COUNT_OFFSET = 4;

// V8 snapshot edge field indices.
const EDGE_TYPE_OFFSET = 0;
const EDGE_NAME_OFFSET = 1;
const EDGE_TO_OFFSET = 2;

const FIVE_MINUTES_MS = 5 * 60 * 1000;

type ParsedSnapshot = {
  nodeCount: number;
  nodeFields: number;
  edgeFields: number;
  nodes: number[];
  edges: number[];
  strings: string[];
  edgeStartsByNode: number[];
};

function parseSnapshot(raw: HeapSnapshotRaw): ParsedSnapshot {
  let parsed: {
    snapshot: {
      meta: {
        node_fields: string[];
        edge_fields: string[];
        node_types: string[][];
      };
    };
    nodes: number[];
    edges: number[];
    strings: string[];
  };

  try {
    parsed = JSON.parse(raw.json) as typeof parsed;
  } catch (err) {
    throw new HeapDiffError('parse_failed', `Failed to parse heap snapshot JSON: ${String(err)}`);
  }

  const meta = parsed.snapshot?.meta;
  if (meta === undefined || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.strings)) {
    throw new HeapDiffError('parse_failed', 'Heap snapshot missing required fields (meta, nodes, strings)');
  }

  const nodeFields = meta.node_fields.length;
  const edgeFields = meta.edge_fields.length;
  const nodes = parsed.nodes;
  const edges = parsed.edges;
  const strings = parsed.strings;
  const nodeCount = nodes.length / nodeFields;

  // Precompute edge start index per node (needed for retainer walk).
  const edgeStartsByNode = new Array<number>(nodeCount + 1).fill(0);
  let edgeCursor = 0;
  for (let n = 0; n < nodeCount; n++) {
    edgeStartsByNode[n] = edgeCursor;
    const edgeCount = nodes[n * nodeFields + NODE_EDGES_COUNT_OFFSET] ?? 0;
    edgeCursor += edgeCount * edgeFields;
  }
  edgeStartsByNode[nodeCount] = edgeCursor;

  return { nodeCount, nodeFields, edgeFields, nodes, edges, strings, edgeStartsByNode };
}

type ConstructorStats = {
  count: number;
  retainedSize: number;
  // Sample node indices for retainer chain walking (first 5 nodes).
  sampleNodeIndices: number[];
};

function gatherConstructorStats(snap: ParsedSnapshot): Map<string, ConstructorStats> {
  const { nodeCount, nodeFields, nodes, strings } = snap;
  const stats = new Map<string, ConstructorStats>();

  for (let n = 0; n < nodeCount; n++) {
    const nameIdx = nodes[n * nodeFields + NODE_NAME_OFFSET] ?? 0;
    const retainedSize = nodes[n * nodeFields + NODE_RETAINED_SIZE_OFFSET] ?? 0;
    const name = strings[nameIdx] ?? '(unknown)';

    let entry = stats.get(name);
    if (entry === undefined) {
      entry = { count: 0, retainedSize: 0, sampleNodeIndices: [] };
      stats.set(name, entry);
    }
    entry.count++;
    entry.retainedSize += retainedSize;
    if (entry.sampleNodeIndices.length < 5) entry.sampleNodeIndices.push(n);
  }

  return stats;
}

function walkRetainerChain(
  nodeIdx: number,
  afterSnap: ParsedSnapshot,
  maxHops: number,
): string[] {
  const { nodeFields, edgeFields, nodes, edges, strings, nodeCount } = afterSnap;

  // Build reverse edges (child → parents) for the target node.
  // We walk from the node up to its retaining parents.
  const chain: string[] = [];
  let current = nodeIdx;
  const visited = new Set<number>();

  for (let hop = 0; hop < maxHops; hop++) {
    // Find a parent of `current` by scanning all edges.
    // This is O(E) per hop — acceptable for ≤3 hops on typical snapshots.
    let parentNodeIdx = -1;
    let parentEdgeType = -1;

    outer: for (let n = 0; n < nodeCount; n++) {
      const edgeStart = afterSnap.edgeStartsByNode[n] ?? 0;
      const edgeEnd = afterSnap.edgeStartsByNode[n + 1] ?? edgeStart;
      for (let e = edgeStart; e < edgeEnd; e += edgeFields) {
        const toNodeOrdinal = (edges[e + EDGE_TO_OFFSET] ?? 0) / nodeFields;
        if (toNodeOrdinal === current && !visited.has(n)) {
          parentNodeIdx = n;
          parentEdgeType = edges[e + EDGE_TYPE_OFFSET] ?? 0;
          // Prefer property-typed edges (type 1) over element edges (type 2).
          if (parentEdgeType === 1) break outer;
        }
      }
    }

    if (parentNodeIdx === -1) break;

    const parentNameIdx = nodes[parentNodeIdx * nodeFields + NODE_NAME_OFFSET] ?? 0;
    const parentName = strings[parentNameIdx] ?? '(unknown)';

    if (!EXCLUDED_RETAINER_ROOTS.has(parentName)) {
      chain.push(parentName);
    }
    visited.add(current);
    current = parentNodeIdx;
  }

  return chain;
}

export class V8HeapSnapshotDiff implements HeapDiffInterface {
  diff(
    beforeRaw: HeapSnapshotRaw,
    afterRaw: HeapSnapshotRaw,
    opts: DiffOptions = {},
  ): HeapSnapshotDiff {
    const beforeSnap = parseSnapshot(beforeRaw);
    const afterSnap = parseSnapshot(afterRaw);

    const beforeStats = gatherConstructorStats(beforeSnap);
    const afterStats = gatherConstructorStats(afterSnap);

    const minInstances = opts.minInstanceDelta ?? 10;
    const minRetained = opts.minRetainedDelta ?? 5_000_000;

    const growthByConstructor: HeapDiffEntry[] = [];

    for (const [name, afterEntry] of afterStats) {
      if (GENERIC_CONSTRUCTORS.has(name)) continue;

      const beforeEntry = beforeStats.get(name);
      const countBefore = beforeEntry?.count ?? 0;
      const retBefore = beforeEntry?.retainedSize ?? 0;
      const countDelta = afterEntry.count - countBefore;
      const retDelta = afterEntry.retainedSize - retBefore;

      if (countDelta <= 0 && retDelta <= 0) continue;
      if (countDelta < minInstances && retDelta < minRetained) continue;

      const sampleNode = afterEntry.sampleNodeIndices[0] ?? -1;
      const retainerChain = sampleNode >= 0
        ? walkRetainerChain(sampleNode, afterSnap, 3)
        : [];

      growthByConstructor.push({
        constructorName: name,
        instanceCountBefore: countBefore,
        instanceCountAfter: afterEntry.count,
        instanceCountDelta: countDelta,
        retainedSizeBefore: retBefore,
        retainedSizeAfter: afterEntry.retainedSize,
        retainedSizeDelta: retDelta,
        retainerChain,
      });
    }

    growthByConstructor.sort((a, b) => b.retainedSizeDelta - a.retainedSizeDelta);

    const timeDiff = afterRaw.capturedAtMs - beforeRaw.capturedAtMs;

    return {
      beforeIdx: opts.beforeIdx ?? 0,
      afterIdx: opts.afterIdx ?? 1,
      capturedAtMsBefore: beforeRaw.capturedAtMs,
      capturedAtMsAfter: afterRaw.capturedAtMs,
      growthByConstructor,
      largeTimeGap: timeDiff > FIVE_MINUTES_MS,
    };
  }
}
