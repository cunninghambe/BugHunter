// Unit tests for V8HeapSnapshotDiff — 8 cases per spec §9 task 12.

import { describe, it, expect } from 'vitest';
import { V8HeapSnapshotDiff, HeapDiffError } from './heap-diff.js';
import type { HeapSnapshotRaw } from '../types.js';

// ─── Snapshot builder helpers ───────────────────────────────────────────────

type NodeSpec = { name: string; retainedSize?: number; edgeCount?: number };
type EdgeSpec = { type: number; nameOrIdx: number; toNodeOrdinal: number };

/**
 * Build a minimal V8 heap-snapshot JSON string from a flat list of nodes + edges.
 * Node field order: type, name, id, retainedSize, edgeCount.
 * Edge field order: type, nameOrIdx, toNode (node-ordinal * nodeFields).
 */
function buildSnapshot(nodes: NodeSpec[], edges: EdgeSpec[] = []): HeapSnapshotRaw {
  const NODE_FIELDS = ['type', 'name', 'id', 'retained_size', 'edge_count'];
  const EDGE_FIELDS = ['type', 'name_or_index', 'to_node'];

  const strings: string[] = [];
  const stringIndex = (s: string): number => {
    const existing = strings.indexOf(s);
    if (existing !== -1) return existing;
    strings.push(s);
    return strings.length - 1;
  };

  const nodesFlat: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    nodesFlat.push(
      0,                        // type
      stringIndex(n.name),      // name
      i,                        // id
      n.retainedSize ?? 1000,   // retained_size
      n.edgeCount ?? 0,         // edge_count
    );
  }

  const edgesFlat: number[] = [];
  for (const e of edges) {
    edgesFlat.push(e.type, e.nameOrIdx, e.toNodeOrdinal * NODE_FIELDS.length);
  }

  const snapshot = {
    snapshot: {
      meta: {
        node_fields: NODE_FIELDS,
        edge_fields: EDGE_FIELDS,
        node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint']],
      },
    },
    nodes: nodesFlat,
    edges: edgesFlat,
    strings,
  };

  return { capturedAtMs: Date.now(), json: JSON.stringify(snapshot) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('V8HeapSnapshotDiff', () => {
  const differ = new V8HeapSnapshotDiff();

  it('T1: identifies +20 instances of class Foo (count delta ≥ 10)', () => {
    const before = buildSnapshot([
      { name: 'Foo', retainedSize: 1000 },
      { name: 'Foo', retainedSize: 1000 },
    ]);
    const afterNodes: NodeSpec[] = [];
    for (let i = 0; i < 22; i++) afterNodes.push({ name: 'Foo', retainedSize: 1000 });
    const after = buildSnapshot(afterNodes);

    const diff = differ.diff(before, after, { minInstanceDelta: 10, minRetainedDelta: 5_000_000 });
    const entry = diff.growthByConstructor.find(e => e.constructorName === 'Foo');
    expect(entry).toBeDefined();
    expect(entry!.instanceCountDelta).toBe(20);
  });

  it('T2: excludes generic constructors (Object, Array, Map, etc.)', () => {
    const before = buildSnapshot([]);
    const afterNodes: NodeSpec[] = [];
    for (let i = 0; i < 20; i++) afterNodes.push({ name: '(Object)', retainedSize: 1000 });
    const after = buildSnapshot(afterNodes);

    const diff = differ.diff(before, after, { minInstanceDelta: 10, minRetainedDelta: 5_000_000 });
    expect(diff.growthByConstructor.every(e => e.constructorName !== '(Object)')).toBe(true);
  });

  it('T3: excludes constructors with negative delta (shrunk)', () => {
    const before: NodeSpec[] = [];
    for (let i = 0; i < 50; i++) before.push({ name: 'BigSet', retainedSize: 10000 });
    const after = buildSnapshot([{ name: 'BigSet', retainedSize: 10000 }]);
    const beforeSnap = buildSnapshot(before);

    const diff = differ.diff(beforeSnap, after, { minInstanceDelta: 1, minRetainedDelta: 1 });
    expect(diff.growthByConstructor.every(e => e.constructorName !== 'BigSet')).toBe(true);
  });

  it('T4: includes constructors that exist only in after snapshot (instanceCountBefore=0)', () => {
    const before = buildSnapshot([{ name: 'Other', retainedSize: 100 }]);
    const afterNodes: NodeSpec[] = [];
    for (let i = 0; i < 15; i++) afterNodes.push({ name: 'NewLeak', retainedSize: 500_000 });
    afterNodes.push({ name: 'Other', retainedSize: 100 });
    const after = buildSnapshot(afterNodes);

    const diff = differ.diff(before, after, { minInstanceDelta: 10, minRetainedDelta: 5_000_000 });
    const entry = diff.growthByConstructor.find(e => e.constructorName === 'NewLeak');
    expect(entry).toBeDefined();
    expect(entry!.instanceCountBefore).toBe(0);
    expect(entry!.instanceCountDelta).toBe(15);
  });

  it('T5: sorts growthByConstructor by retainedSizeDelta DESC', () => {
    const before = buildSnapshot([]);
    const afterNodes: NodeSpec[] = [];
    for (let i = 0; i < 10; i++) afterNodes.push({ name: 'Small', retainedSize: 100_000 });
    for (let i = 0; i < 10; i++) afterNodes.push({ name: 'Large', retainedSize: 1_000_000 });
    const after = buildSnapshot(afterNodes);

    const diff = differ.diff(before, after, { minInstanceDelta: 10, minRetainedDelta: 1 });
    if (diff.growthByConstructor.length >= 2) {
      expect(diff.growthByConstructor[0]!.retainedSizeDelta)
        .toBeGreaterThanOrEqual(diff.growthByConstructor[1]!.retainedSizeDelta);
    }
  });

  it('T6: flags largeTimeGap when snapshots are >5 minutes apart', () => {
    const before = buildSnapshot([]);
    const after = buildSnapshot([]);
    before.capturedAtMs = 0;
    after.capturedAtMs = 6 * 60 * 1000; // 6 minutes later

    const diff = differ.diff(before, after);
    expect(diff.largeTimeGap).toBe(true);
  });

  it('T7: does not flag largeTimeGap when snapshots are <5 minutes apart', () => {
    const before = buildSnapshot([]);
    const after = buildSnapshot([]);
    before.capturedAtMs = 0;
    after.capturedAtMs = 4 * 60 * 1000; // 4 minutes

    const diff = differ.diff(before, after);
    expect(diff.largeTimeGap).toBe(false);
  });

  it('T8: throws HeapDiffError with code parse_failed on malformed JSON', () => {
    const malformed: HeapSnapshotRaw = { capturedAtMs: Date.now(), json: '{invalid json' };
    const good = buildSnapshot([]);
    expect(() => differ.diff(malformed, good)).toThrow(HeapDiffError);
    try {
      differ.diff(malformed, good);
    } catch (err) {
      expect(err instanceof HeapDiffError).toBe(true);
      expect((err as HeapDiffError).code).toBe('parse_failed');
    }
  });
});
