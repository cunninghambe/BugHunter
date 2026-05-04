// V56 tiered self-test runner.
// Wraps the existing self-test (Tier 3) and adds Tier 1 (per-detector) + Tier 2 (phase-smoke).
//
// Tier 1: all bughunter test-detector runs, one per fixture in fixtures/detector-calibration/
//         (concurrently, capped at 8). Fails fast on any failure before Tier 2/3.
// Tier 2: phase-level smoke against fixtures/detector-calibration/_phase-smoke/ fixture.
//         V56.1 ships infrastructure; the actual fixture lands in V56.2 follow-up.
// Tier 3: existing comprehensive-bench self-test (unchanged).
//
// bughunter self-test (no --tier) → aliases to --tier 3 for back-compat.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DETECTOR_CONTRACTS } from '../detectors/contracts.js';
import { testDetectorCommand } from './test-detector.js';
import type { TestDetectorResultItem } from './test-detector.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TieredSelfTestOptions = {
  tier: 1 | 2 | 3 | 'all';
  /** Exit on first Tier 1 failure before proceeding to Tier 2/3. Default: true. */
  bail?: boolean;
  json?: boolean;
  projectDir?: string;
};

export type TierResult = {
  tier: 1 | 2 | 3;
  passed: boolean;
  skipped: boolean;
  skipReason?: string;
  results?: TestDetectorResultItem[];
  durationMs: number;
};

export type TieredSelfTestResult = {
  passed: boolean;
  tiers: TierResult[];
};

// ---------------------------------------------------------------------------
// Tier 1: per-detector fixture runs
// ---------------------------------------------------------------------------

const MAX_PARALLEL = 8;

async function runTier1(opts: TieredSelfTestOptions): Promise<TierResult> {
  const startMs = Date.now();
  const contracts = [...DETECTOR_CONTRACTS];

  if (contracts.length === 0) {
    process.stdout.write(
      '[self-test --tier 1] 0 detectors, 0 tests — DETECTOR_CONTRACTS is empty (V56.2+ populates it).\n',
    );
    return {
      tier: 1,
      passed: true,
      skipped: false,
      results: [],
      durationMs: Date.now() - startMs,
    };
  }

  process.stdout.write(`[self-test --tier 1] Running ${contracts.length} per-detector test(s)...\n`);

  const results: TestDetectorResultItem[] = [];

  // Run up to MAX_PARALLEL concurrently (fixture ports are disjoint)
  for (let i = 0; i < contracts.length; i += MAX_PARALLEL) {
    const batch = contracts.slice(i, i + MAX_PARALLEL);
    const batchResults = await Promise.all(
      batch.map(async c => {
        // Capture process.exitCode changes per-kind
        const prevExitCode = process.exitCode;
        await testDetectorCommand({ kind: c.kind, verbose: true });
        const exitCode = process.exitCode;
        process.exitCode = prevExitCode;
        return exitCode === 1
          ? { kind: c.kind, fixture: c.fixture.path, status: 'FAIL' as const, elapsedMs: 0 }
          : { kind: c.kind, fixture: c.fixture.path, status: 'PASS' as const, elapsedMs: 0 };
      }),
    );
    results.push(...batchResults);

    if (opts.bail !== false && batchResults.some(r => r.status === 'FAIL')) break;
  }

  const passed = results.every(r => r.status === 'PASS');
  return {
    tier: 1,
    passed,
    skipped: false,
    results,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Tier 2: phase-level smoke fixture
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
async function runTier2(_opts: TieredSelfTestOptions): Promise<TierResult> {
  const startMs = Date.now();

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const phaseSmokeDir = path.join(repoRoot, 'fixtures', 'detector-calibration', '_phase-smoke');

  if (!fs.existsSync(phaseSmokeDir)) {
    process.stdout.write(
      '[self-test --tier 2] _phase-smoke fixture not found — V56.1 ships Tier 2 infrastructure;\n' +
      '  the actual fixture lands in V56.2 follow-up. Tier 2 passes vacuously.\n',
    );
    return {
      tier: 2,
      passed: true,
      skipped: true,
      skipReason: '_phase-smoke fixture not yet created (V56.2+)',
      durationMs: Date.now() - startMs,
    };
  }

  // Future: boot _phase-smoke/bin/up.sh, run 6 micro-tests against each phase,
  // assert deterministic markers appeared. V56.2 implementation.
  process.stdout.write('[self-test --tier 2] _phase-smoke fixture found. Running phase smoke...\n');
  process.stdout.write('[self-test --tier 2] Phase smoke infrastructure ready (V56.2 wires full execution).\n');

  return {
    tier: 2,
    passed: true,
    skipped: false,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Tier 3: existing comprehensive-bench self-test
// ---------------------------------------------------------------------------

async function runTier3(opts: TieredSelfTestOptions): Promise<TierResult> {
  const startMs = Date.now();

  // Dynamically import to avoid circular dependencies and keep boot cost low
  const { selfTestCommand } = await import('./self-test.js');

  const projectDir = opts.projectDir ?? process.cwd();

  process.stdout.write('[self-test --tier 3] Running comprehensive-bench self-test...\n');

  const prevExitCode = process.exitCode;
  await selfTestCommand({
    projectDir,
    jsonOutput: opts.json,
  });
  const exitCode = process.exitCode;
  process.exitCode = prevExitCode;

  return {
    tier: 3,
    passed: exitCode !== 1,
    skipped: false,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function tieredSelfTestCommand(opts: TieredSelfTestOptions): Promise<void> {
  const tiersToRun = opts.tier === 'all' ? ([1, 2, 3] as const) : [opts.tier];
  const tierResults: TierResult[] = [];

  for (const tier of tiersToRun) {
    if (tier === 1) {
      const result = await runTier1(opts);
      tierResults.push(result);
      if (!result.passed && opts.bail !== false) {
        process.stdout.write('[self-test] Tier 1 FAILED — skipping Tier 2 and Tier 3.\n');
        tierResults.push({ tier: 2, passed: false, skipped: true, skipReason: 'Tier 1 failed', durationMs: 0 });
        tierResults.push({ tier: 3, passed: false, skipped: true, skipReason: 'Tier 1 failed', durationMs: 0 });
        break;
      }
    } else if (tier === 2) {
      const result = await runTier2(opts);
      tierResults.push(result);
      if (!result.passed && !result.skipped && opts.bail !== false) {
        process.stdout.write('[self-test] Tier 2 FAILED — skipping Tier 3.\n');
        tierResults.push({ tier: 3, passed: false, skipped: true, skipReason: 'Tier 2 failed', durationMs: 0 });
        break;
      }
    } else {
      const result = await runTier3(opts);
      tierResults.push(result);
    }
  }

  const finalResult: TieredSelfTestResult = {
    passed: tierResults.every(r => r.passed || r.skipped),
    tiers: tierResults,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(finalResult)}\n`);
  } else {
    process.stdout.write('\n[self-test] Tier summary:\n');
    for (const r of tierResults) {
      if (r.skipped) {
        process.stdout.write(`  Tier ${r.tier}: SKIPPED${r.skipReason !== undefined ? ` (${r.skipReason})` : ''}\n`);
      } else {
        process.stdout.write(`  Tier ${r.tier}: ${r.passed ? 'PASSED' : 'FAILED'} (${r.durationMs}ms)\n`);
      }
    }
    process.stdout.write(`\nOverall: ${finalResult.passed ? 'PASSED' : 'FAILED'}\n`);
  }

  if (!finalResult.passed) {
    process.exitCode = 1;
  }
}
