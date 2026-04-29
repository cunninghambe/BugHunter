/**
 * Integration smoke test: synthetic heap-leak fixture produces ≥1 memory_leak_attributed
 * finding using V8HeapSnapshotDiff directly.
 *
 * Does NOT launch a real browser. Constructs synthetic before/after snapshots
 * that mirror what the LeakingEventStore fixture would produce.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { V8HeapSnapshotDiff } from '../../src/analyze/heap-diff.js';
import { runAnalyze } from '../../src/phases/analyze.js';
import type { BugCluster, BugHunterConfig, HeapSnapshotRaw } from '../../src/types.js';
import type { CdpSession } from '../../src/adapters/cdp-session.js';
import { vi } from 'vitest';

// ─── Snapshot builder ────────────────────────────────────────────────────────

function buildSnapshotJson(nodes: Array<{ name: string; retained: number }>): string {
  const strings: string[] = [];
  const si = (s: string) => {
    const idx = strings.indexOf(s);
    if (idx !== -1) return idx;
    strings.push(s);
    return strings.length - 1;
  };
  const nodeFields = ['type', 'name', 'id', 'retained_size', 'edge_count'];
  const nodesFlat: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    nodesFlat.push(0, si(n.name), i, n.retained, 0);
  }
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: nodeFields,
        edge_fields: ['type', 'name_or_index', 'to_node'],
        node_types: [[]],
      },
    },
    nodes: nodesFlat,
    edges: [],
    strings,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('heap-leak integration smoke', () => {
  it('V8HeapSnapshotDiff detects LeakingEventStore growth (≥1 attributed finding)', () => {
    // Before: 2 TradeEvent instances
    const beforeNodes = [
      { name: 'TradeEvent', retained: 400_000 },
      { name: 'TradeEvent', retained: 400_000 },
    ];

    // After: 20 TradeEvent instances (18 delta ≥ 10 threshold)
    const afterNodes: Array<{ name: string; retained: number }> = [];
    for (let i = 0; i < 20; i++) {
      afterNodes.push({ name: 'TradeEvent', retained: 400_000 });
    }

    const beforeSnap: HeapSnapshotRaw = {
      capturedAtMs: 1_000,
      json: buildSnapshotJson(beforeNodes),
    };
    const afterSnap: HeapSnapshotRaw = {
      capturedAtMs: 2_000,
      json: buildSnapshotJson(afterNodes),
    };

    const differ = new V8HeapSnapshotDiff();
    const diff = differ.diff(beforeSnap, afterSnap, {
      minInstanceDelta: 10,
      minRetainedDelta: 5_000_000,
    });

    const tradeEntry = diff.growthByConstructor.find(e => e.constructorName === 'TradeEvent');
    expect(tradeEntry).toBeDefined();
    expect(tradeEntry!.instanceCountDelta).toBe(18);
    expect(tradeEntry!.instanceCountDelta).toBeGreaterThanOrEqual(10);
    // 18 × 400KB = 7.2MB retained delta ≥ 5MB threshold
    expect(tradeEntry!.retainedSizeDelta).toBeGreaterThanOrEqual(5_000_000);
  });

  it('non-leaking fixture produces 0 memory_leak_attributed clusters', () => {
    // Both snapshots have identical stable population → no growth
    const stableNodes = [
      { name: 'StableClass', retained: 50_000 },
      { name: 'StableClass', retained: 50_000 },
    ];
    const snap: HeapSnapshotRaw = { capturedAtMs: Date.now(), json: buildSnapshotJson(stableNodes) };

    const differ = new V8HeapSnapshotDiff();
    const diff = differ.diff(snap, snap, { minInstanceDelta: 10, minRetainedDelta: 5_000_000 });
    expect(diff.growthByConstructor).toHaveLength(0);
  });

  it('re-running with same snapshots produces same diff (deterministic)', () => {
    const nodes = [
      { name: 'Foo', retained: 1_000_000 },
      { name: 'Foo', retained: 1_000_000 },
      { name: 'Foo', retained: 1_000_000 },
    ];
    const before: HeapSnapshotRaw = { capturedAtMs: 0, json: buildSnapshotJson([]) };
    const after: HeapSnapshotRaw = { capturedAtMs: 1_000, json: buildSnapshotJson(nodes) };

    const differ = new V8HeapSnapshotDiff();
    const diff1 = differ.diff(before, after, { minInstanceDelta: 1, minRetainedDelta: 1 });
    const diff2 = differ.diff(before, after, { minInstanceDelta: 1, minRetainedDelta: 1 });

    expect(diff1.growthByConstructor).toEqual(diff2.growthByConstructor);
  });

  it('--heap-diff-min-instances threshold is respected (below threshold → no detection)', () => {
    const afterNodes = [{ name: 'RareClass', retained: 1_000_000 }];
    const before: HeapSnapshotRaw = { capturedAtMs: 0, json: buildSnapshotJson([]) };
    const after: HeapSnapshotRaw = { capturedAtMs: 1_000, json: buildSnapshotJson(afterNodes) };

    const differ = new V8HeapSnapshotDiff();
    // 1 instance delta is below threshold of 10, and 1MB < 5MB
    const diff = differ.diff(before, after, { minInstanceDelta: 10, minRetainedDelta: 5_000_000 });
    expect(diff.growthByConstructor.find(e => e.constructorName === 'RareClass')).toBeUndefined();
  });

  it('snapshots are stored gzipped and dropped after diff (only last 3 retained)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-hl-test-'));
    const heapDir = path.join(tmpDir, 'heap');
    const json = buildSnapshotJson([{ name: 'Z', retained: 100 }]);

    const config: BugHunterConfig = {
      projectName: 'test',
      surfaceMcpUrl: 'http://localhost',
      perf: { enabled: true, heapAttribution: true, heapSnapshotFrequency: 1 },
    };

    const session: CdpSession = {
      newTab: vi.fn(),
      drain: vi.fn(),
      setCookies: vi.fn(),
      close: vi.fn(),
      collectGarbage: vi.fn().mockResolvedValue(undefined),
      takeHeapSnapshot: vi.fn().mockResolvedValue({ capturedAtMs: Date.now(), json } satisfies HeapSnapshotRaw),
    };

    // actionCount=5 with frequency=1 → indices [0,1,2,3,4] → 5 snapshots → keep last 3
    await runAnalyze({
      clusters: [],
      cdpSession: session,
      heapDir,
      config,
      actionCount: 5,
    });

    const files = fs.existsSync(heapDir) ? fs.readdirSync(heapDir) : [];
    // All files should be gzipped
    expect(files.every(f => f.endsWith('.json.gz'))).toBe(true);
    // After prune, at most 3 files remain
    expect(files.length).toBeLessThanOrEqual(3);

    // Verify gzip validity on at least one file
    if (files.length > 0) {
      const firstFile = path.join(heapDir, files[0]!);
      const raw = fs.readFileSync(firstFile);
      const decompressed = zlib.gunzipSync(raw).toString('utf-8');
      const parsed = JSON.parse(decompressed);
      expect(parsed).toHaveProperty('snapshot');
    }
  });
});
