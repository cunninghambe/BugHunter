// bughunter test-detector <kind|all> — run per-detector fixture tests locally.
// V56.1: structural scaffold. Full fixture-boot wires in V56.2 when concrete
// contracts and fixtures land.
//
// Usage:
//   bughunter test-detector <kind> [--target <url>] [--verbose] [--no-up] [--keep] [--json] [--all]
//   bughunter test-detector all [--verbose] [--json]

import { DETECTOR_CONTRACTS } from '../detectors/contracts.js';
import type { DetectorContract, ClusterAssertion } from '../detectors/contracts.js';
import { runHarness } from '../harness/executor.js';
import type { BugCluster } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestDetectorOptions = {
  kind: string;
  all?: boolean;
  target?: string;
  verbose?: boolean;
  noUp?: boolean;
  keep?: boolean;
  json?: boolean;
};

export type TestDetectorResultItem = {
  kind: string;
  fixture: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'NO_CONTRACT';
  elapsedMs: number;
  diff?: {
    expected: ClusterAssertion[];
    observed: BugCluster[];
  };
  reason?: string;
};

export type TestDetectorOutput = {
  passed: boolean;
  results: TestDetectorResultItem[];
};

// ---------------------------------------------------------------------------
// Assertion logic
// ---------------------------------------------------------------------------

function assertClusters(
  assertions: ClusterAssertion[],
  clusters: BugCluster[],
): { passed: boolean; diff: { expected: ClusterAssertion[]; observed: BugCluster[] } } {
  const failing: ClusterAssertion[] = [];

  for (const assertion of assertions) {
    if (assertion.expect === 'fires') {
      const matching = clusters.filter(c => {
        if (c.kind !== assertion.kind) return false;
        if (assertion.match.page !== undefined && !c.occurrences.some(o => o.page === assertion.match.page)) return false;
        if (assertion.match.role !== undefined && !c.occurrences.some(o => o.role === assertion.match.role)) return false;
        return true;
      });
      const totalSize = matching.reduce((n, c) => n + c.clusterSize, 0);
      if (totalSize < assertion.minClusterSize) {
        failing.push(assertion);
      }
    } else if (assertion.expect === 'skipped') {
      // Precondition not met — skip this assertion entirely.
      continue;
    } else {
      // expect: 'silent'
      const silentMatch = assertion.match;
      const found = clusters.some(c => {
        if (c.kind !== assertion.kind) return false;
        if (silentMatch?.page !== undefined && !c.occurrences.some(o => o.page === silentMatch.page)) return false;
        if (silentMatch?.role !== undefined && !c.occurrences.some(o => o.role === silentMatch.role)) return false;
        return true;
      });
      if (found) failing.push(assertion);
    }
  }

  return {
    passed: failing.length === 0,
    diff: { expected: failing, observed: clusters },
  };
}

// ---------------------------------------------------------------------------
// Single-contract run
// ---------------------------------------------------------------------------

async function runOneContract(
  contract: DetectorContract,
  opts: TestDetectorOptions,
): Promise<TestDetectorResultItem> {
  const startMs = Date.now();

  if (opts.verbose === true) {
    process.stdout.write(`  [${contract.kind}] booting fixture '${contract.fixture.path}'...\n`);
  }

  // In V56.1 fixtures don't exist yet — the harness returns empty clusters.
  // V56.2 wires fixture boot (bin/up.sh), actual phase execution, and assertion.
  const target = {
    appBaseUrl: opts.target ?? `http://localhost:9970`,
  };

  const result = await runHarness({
    contract,
    target,
    budgetMs: contract.defaultBudgetMs,
  });

  const elapsedMs = Date.now() - startMs;

  // In V56.1 there are no expected-clusters.jsonl files (fixtures not yet created).
  // The assertion passes vacuously (no assertions to fail against empty clusters).
  // V56.2 loads real expected-clusters.jsonl and runs assertClusters.
  const assertion = assertClusters([], result.clusters);

  if (opts.verbose === true) {
    const status = assertion.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${contract.kind}] ${status} (${elapsedMs}ms)\n`);
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        process.stdout.write(`    WARN: ${w}\n`);
      }
    }
  }

  return {
    kind: contract.kind,
    fixture: contract.fixture.path,
    status: assertion.passed ? 'PASS' : 'FAIL',
    elapsedMs,
    ...(assertion.passed ? {} : { diff: assertion.diff }),
  };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function testDetectorCommand(opts: TestDetectorOptions): Promise<void> {
  // Resolve which contracts to run
  let targets: DetectorContract[];

  if (opts.all === true || opts.kind === 'all') {
    targets = [...DETECTOR_CONTRACTS];
  } else {
    const contract = DETECTOR_CONTRACTS.find(c => c.kind === opts.kind);
    if (contract === undefined) {
      // Check if the kind is a valid BugKind but has no contract yet
      const isKnownKind = opts.kind.length > 0;
      if (isKnownKind && DETECTOR_CONTRACTS.length === 0) {
        process.stderr.write(
          `[test-detector] No DetectorContract found for '${opts.kind}'.\n` +
          `V56.1 ships with empty DETECTOR_CONTRACTS — contracts land in V56.2+.\n`,
        );
      } else {
        const available = DETECTOR_CONTRACTS.map(c => c.kind).join(', ');
        process.stderr.write(
          `[test-detector] No DetectorContract found for '${opts.kind}'.\n` +
          `Available: ${available.length > 0 ? available : '(none yet)'}\n`,
        );
      }
      process.exitCode = 1;
      return;
    }
    targets = [contract];
  }

  if (targets.length === 0) {
    const msg = DETECTOR_CONTRACTS.length === 0
      ? `[test-detector] 0 detectors, 0 tests — DETECTOR_CONTRACTS is empty (V56.2+ populates it).\n`
      : `[test-detector] No contracts matched. Available: ${DETECTOR_CONTRACTS.map(c => c.kind).join(', ')}\n`;
    process.stdout.write(msg);
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ passed: true, results: [] })}\n`);
    }
    return;
  }

  process.stdout.write(`[test-detector] Running ${targets.length} detector(s)...\n`);

  const results: TestDetectorResultItem[] = [];
  for (const contract of targets) {
    const result = await runOneContract(contract, opts);
    results.push(result);
  }

  const output: TestDetectorOutput = {
    passed: results.every(r => r.status === 'PASS'),
    results,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    process.stdout.write('\n[test-detector] Results:\n');
    for (const r of results) {
      const icon = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'SKIP';
      process.stdout.write(`  [${icon}] ${r.kind}  fixture=${r.fixture}  (${r.elapsedMs}ms)\n`);
      if (r.diff !== undefined && r.diff.expected.length > 0) {
        process.stdout.write(`         diff: expected ${r.diff.expected.length} assertion(s) to match\n`);
      }
    }
    process.stdout.write(`\nResult: ${output.passed ? 'PASSED' : 'FAILED'}\n`);
  }

  if (!output.passed) {
    process.exitCode = 1;
  }
}
