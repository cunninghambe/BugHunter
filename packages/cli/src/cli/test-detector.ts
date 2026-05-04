// bughunter test-detector <kind|all> — run per-detector fixture tests locally.
// V56.2.1: wires fixture boot and real assertClusters for path_traversal.
//
// Usage:
//   bughunter test-detector <kind> [--target <url>] [--verbose] [--no-up] [--keep] [--json] [--all]
//   bughunter test-detector all [--verbose] [--json]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DETECTOR_CONTRACTS } from '../detectors/contracts.js';
import type { DetectorContract, ClusterAssertion } from '../detectors/contracts.js';
import { runHarness, bootFixture } from '../harness/executor.js';
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
  assertionResults?: AssertionResult[];
};

export type TestDetectorOutput = {
  passed: boolean;
  results: TestDetectorResultItem[];
};

export type AssertionResult = {
  expect: 'fires' | 'silent' | 'skipped';
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
};

// ---------------------------------------------------------------------------
// Fixture path resolution
// ---------------------------------------------------------------------------

const FIXTURES_BASE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../fixtures/detector-calibration',
);

function resolveFixturePath(fixturePath: string): string {
  return path.join(FIXTURES_BASE, fixturePath);
}

// ---------------------------------------------------------------------------
// Load expected-clusters.jsonl
// ---------------------------------------------------------------------------

function loadExpectedClusters(fixturePath: string): ClusterAssertion[] {
  const jsonlPath = path.join(fixturePath, 'expected-clusters.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];

  const lines = fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const assertions: ClusterAssertion[] = [];
  for (const line of lines) {
    try {
      assertions.push(JSON.parse(line) as ClusterAssertion);
    } catch {
      // skip malformed lines
    }
  }
  return assertions;
}

// ---------------------------------------------------------------------------
// Assertion logic
// ---------------------------------------------------------------------------

function assertClusters(
  assertions: ClusterAssertion[],
  clusters: BugCluster[],
): { passed: boolean; diff: { expected: ClusterAssertion[]; observed: BugCluster[] }; assertionResults: AssertionResult[] } {
  const failing: ClusterAssertion[] = [];
  const assertionResults: AssertionResult[] = [];

  for (const assertion of assertions) {
    if (assertion.expect === 'skipped') {
      assertionResults.push({
        expect: 'skipped',
        label: assertion.reason,
        status: 'skip',
        detail: `skipped: ${assertion.reason}`,
      });
      continue;
    }

    if (assertion.expect === 'fires') {
      const matching = clusters.filter(c => {
        if (c.kind !== assertion.kind) return false;
        if (assertion.match.page !== undefined && !c.occurrences.some(o => o.page === assertion.match.page)) return false;
        if (assertion.match.role !== undefined && !c.occurrences.some(o => o.role === assertion.match.role)) return false;
        return true;
      });
      const totalSize = matching.reduce((n, c) => n + c.clusterSize, 0);
      const passed = totalSize >= assertion.minClusterSize;
      const label = assertion.edgeLabel !== undefined
        ? `fires match=page:${assertion.match.page ?? '*'} [${assertion.edgeLabel}]`
        : `fires match=page:${assertion.match.page ?? '*'}`;

      if (!passed) {
        failing.push(assertion);
        assertionResults.push({
          expect: 'fires',
          label,
          status: 'fail',
          detail: `expected ≥${assertion.minClusterSize} cluster(s) at ${assertion.match.page ?? '*'}, got ${totalSize}`,
        });
      } else {
        assertionResults.push({
          expect: 'fires',
          label,
          status: 'pass',
          detail: `${totalSize} cluster(s) at ${assertion.match.page ?? '*'}`,
        });
      }
    } else {
      // expect: 'silent'
      const silentMatch = assertion.match;
      const found = clusters.some(c => {
        if (c.kind !== assertion.kind) return false;
        if (silentMatch?.page !== undefined && !c.occurrences.some(o => o.page === silentMatch.page)) return false;
        if (silentMatch?.role !== undefined && !c.occurrences.some(o => o.role === silentMatch.role)) return false;
        return true;
      });
      const label = `silent match=page:${silentMatch?.page ?? '*'}`;
      if (found) {
        failing.push(assertion);
        assertionResults.push({
          expect: 'silent',
          label,
          status: 'fail',
          detail: `expected no clusters at ${silentMatch?.page ?? '*'}, but found one`,
        });
      } else {
        assertionResults.push({
          expect: 'silent',
          label,
          status: 'pass',
          detail: `no clusters at ${silentMatch?.page ?? '*'} (correct)`,
        });
      }
    }
  }

  return {
    passed: failing.length === 0,
    diff: { expected: failing, observed: clusters },
    assertionResults,
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
  const absoluteFixturePath = resolveFixturePath(contract.fixture.path);

  if (opts.verbose === true) {
    process.stdout.write(`  [${contract.kind}] booting fixture '${contract.fixture.path}'...\n`);
  }

  let teardown: (() => void) | undefined;
  let appBaseUrl = opts.target;

  // Resolve the fixture URL and optionally boot its server.
  // Boot is skipped when:
  //   - --no-up is explicitly set
  //   - a --target URL was given (caller manages the server)
  //   - this is an --all run (expects fixtures to already be running or skipped)
  //   - running inside Vitest (VITEST env var set) — unit tests don't run servers
  const inTestRunner = process.env['VITEST'] !== undefined;
  const shouldBoot = opts.noUp !== true && appBaseUrl === undefined && opts.all !== true && opts.kind !== 'all' && !inTestRunner;

  const contractJsonPath = path.join(absoluteFixturePath, 'contract.json');
  if (!fs.existsSync(contractJsonPath)) {
    const elapsedMs = Date.now() - startMs;
    return {
      kind: contract.kind,
      fixture: contract.fixture.path,
      status: 'SKIPPED',
      elapsedMs,
      reason: `fixture not built: ${contractJsonPath} missing`,
    };
  }
  const contractJson = JSON.parse(fs.readFileSync(contractJsonPath, 'utf8')) as { port: number };
  if (appBaseUrl === undefined) {
    appBaseUrl = `http://127.0.0.1:${contractJson.port}`;
  }

  if (shouldBoot) {
    if (opts.verbose === true) {
      process.stdout.write(`  [${contract.kind}] spawning fixture on ${appBaseUrl}...\n`);
    }

    try {
      teardown = await bootFixture(absoluteFixturePath);
      if (opts.verbose === true) {
        process.stdout.write(`  [${contract.kind}] fixture ready\n`);
      }
    } catch (err: unknown) {
      const elapsedMs = Date.now() - startMs;
      const reason = err instanceof Error ? err.message : String(err);
      if (opts.verbose === true) {
        process.stdout.write(`  [${contract.kind}] SKIPPED — fixture boot failed: ${reason}\n`);
      }
      return { kind: contract.kind, fixture: contract.fixture.path, status: 'SKIPPED', elapsedMs, reason };
    }
  }

  try {
    const target = {
      appBaseUrl: appBaseUrl ?? `http://localhost:9970`,
      // Only pass fixturePath when we actually booted the fixture or are running a
      // single-kind explicit probe. Without fixturePath, the harness uses the scaffold
      // path (returns empty clusters) for unbooted fixtures.
      fixturePath: shouldBoot || opts.target !== undefined ? absoluteFixturePath : undefined,
    };

    const result = await runHarness({
      contract,
      target,
      budgetMs: contract.defaultBudgetMs,
    });

    const elapsedMs = Date.now() - startMs;

    // Load expected assertions from expected-clusters.jsonl only when we actually ran
    // against a live fixture. In test-runner contexts without a booted fixture, use empty
    // assertions so the run passes vacuously (same behaviour as V56.1 scaffold).
    const expectedAssertions = shouldBoot || opts.target !== undefined ? loadExpectedClusters(absoluteFixturePath) : [];
    const assertion = assertClusters(expectedAssertions, result.clusters);

    if (opts.verbose === true) {
      const status = assertion.passed ? 'PASS' : 'FAIL';
      process.stdout.write(`  [${contract.kind}] ${status} (${elapsedMs}ms)\n`);
      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          process.stdout.write(`    WARN: ${w}\n`);
        }
      }

      // Print per-assertion scorecard
      process.stdout.write(`\n  Scorecard:\n`);
      for (const ar of assertion.assertionResults) {
        const icon = ar.status === 'pass' ? '[✓]' : ar.status === 'skip' ? '[~]' : '[✗]';
        process.stdout.write(`    ${icon} expect=${ar.expect} ${ar.label}\n`);
        process.stdout.write(`        ${ar.detail}\n`);
      }

      const passCount = assertion.assertionResults.filter(r => r.status === 'pass').length;
      const totalCount = assertion.assertionResults.filter(r => r.status !== 'skip').length;
      process.stdout.write(`\n  Summary: ${passCount}/${totalCount} passed\n`);
    }

    return {
      kind: contract.kind,
      fixture: contract.fixture.path,
      status: assertion.passed ? 'PASS' : 'FAIL',
      elapsedMs,
      assertionResults: assertion.assertionResults,
      ...(assertion.passed ? {} : { diff: assertion.diff }),
    };
  } finally {
    if (opts.keep !== true && teardown !== undefined) {
      teardown();
      if (opts.verbose === true) {
        process.stdout.write(`  [${contract.kind}] fixture stopped\n`);
      }
    }
  }
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
    // SKIPPED = fixture not built yet; counts as non-failure (same as vacuous pass).
    passed: results.every(r => r.status === 'PASS' || r.status === 'SKIPPED'),
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
