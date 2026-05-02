// bughunter self-test — runs BugHunter against the self-deliberate-bugs fixture
// and asserts every wired BugKind fires (and every deferred kind stays absent).
// See SPEC_V33_SELF_TEST.md for full specification.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import { runCommand } from './run.js';
import { listRunIds, runPaths, fileExists } from '../store/filesystem.js';
import type { BugKind } from '../types.js';
import type { BugCluster } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SelfTestOptions = {
  projectDir: string;
  budgetMs?: number;
  maxBugs?: number;
  jsonOutput?: boolean;
  failOnFlake?: boolean;
  keepRun?: boolean;
  skipFixtureUp?: boolean;
};

export type SelfTestResult = {
  passed: boolean;
  elapsedMs: number;
  budgetMs: number;
  budgetOk: boolean;
  positives: Array<{ kind: BugKind; expected: number; matched: number; status: 'PASS' | 'MISS' | 'FLAKED' }>;
  negatives: Array<{ kind: BugKind; observed: number; status: 'PASS' | 'FALSE_POSITIVE' }>;
  unexpectedKinds: BugKind[];
};

// ---------------------------------------------------------------------------
// Expectation types (mirrors golden-bugs.jsonl format)
// ---------------------------------------------------------------------------

type PositiveExpectation = {
  kind: BugKind;
  signaturePrefix: string;
  minClusterSize?: number;
  rootCauseSubstring?: string;
  fixture: string;
  specReference: string;
  acceptableMisses?: 0 | 1;
};

type NegativeExpectation = {
  expect: 'absent';
  kind: BugKind;
  reason: string;
};

type DetectorSilentExpectation = {
  expect: 'detector_silent';
  kind: BugKind;
  reason: string;
};

type GoldenLine = PositiveExpectation | NegativeExpectation | DetectorSilentExpectation;

// ---------------------------------------------------------------------------
// Manifest type (reuse-manifest.json)
// ---------------------------------------------------------------------------

type ManifestKindEntry = {
  fixture: string;
  port: number | null;
  route: string;
};

type ReuseManifest = {
  comment?: string;
  kinds: Record<string, ManifestKindEntry>;
  deferred: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixtureRootFor(selfProjectDir: string): string {
  // Locate the fixture relative to the package root.
  // When invoked from the BugHunter repo, selfProjectDir is process.cwd().
  // We search upward from the CLI package for a known marker.
  const candidates = [
    path.join(selfProjectDir, 'fixtures', 'bughunter-self-deliberate-bugs'),
    path.join(selfProjectDir, '..', 'fixtures', 'bughunter-self-deliberate-bugs'),
    path.join(selfProjectDir, '..', '..', 'fixtures', 'bughunter-self-deliberate-bugs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'reuse-manifest.json'))) return candidate;
  }
  throw new SelfTestSetupError(
    `Cannot locate fixtures/bughunter-self-deliberate-bugs/ relative to "${selfProjectDir}". ` +
    'bughunter self-test must be run from a BugHunter repo checkout.',
  );
}

function readManifest(fixtureRoot: string): ReuseManifest {
  const p = path.join(fixtureRoot, 'reuse-manifest.json');
  if (!fs.existsSync(p)) throw new SelfTestSetupError(`reuse-manifest.json not found at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ReuseManifest;
}

function readGolden(fixtureRoot: string): GoldenLine[] {
  const p = path.join(fixtureRoot, 'golden-bugs.jsonl');
  if (!fs.existsSync(p)) throw new SelfTestSetupError(`golden-bugs.jsonl not found at ${p}`);
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as GoldenLine);
}

function readBugsJsonl(fixtureRoot: string, runId: string): BugCluster[] {
  const paths = runPaths(fixtureRoot, runId);
  if (!fileExists(paths.bugsFile)) return [];
  return fs
    .readFileSync(paths.bugsFile, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as BugCluster);
}

function latestRunId(fixtureRoot: string): string {
  const ids = listRunIds(fixtureRoot).sort();
  if (ids.length === 0) throw new SelfTestSetupError('No runs found in fixture after BugHunter run.');
  return ids[ids.length - 1];
}

// ---------------------------------------------------------------------------
// Lockstep enforcement (§5.3)
// ---------------------------------------------------------------------------

export class LockstepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockstepError';
  }
}

export class SelfTestSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfTestSetupError';
  }
}

export function assertLockstep(manifest: ReuseManifest, goldenLines: GoldenLine[]): void {
  const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
  const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

  const manifestKinds = new Set(Object.keys(manifest.kinds));
  const goldenPositiveKinds = new Set(
    goldenLines
      .filter((l): l is PositiveExpectation => !('expect' in l))
      .map(l => l.kind),
  );
  const goldenSilentKinds = new Set(
    goldenLines
      .filter((l): l is DetectorSilentExpectation => 'expect' in l && l.expect === 'detector_silent')
      .map(l => l.kind),
  );
  const goldenNegativeKinds = new Set(
    goldenLines
      .filter((l): l is NegativeExpectation => 'expect' in l && l.expect === 'absent')
      .map(l => l.kind),
  );
  const manifestDeferred = new Set(manifest.deferred);

  const errors: string[] = [];

  for (const kind of wiredKinds) {
    if (!manifestKinds.has(kind)) {
      errors.push(`Wired kind "${kind}" is missing from reuse-manifest.json.kinds`);
    }
    if (!goldenPositiveKinds.has(kind) && !goldenSilentKinds.has(kind)) {
      errors.push(`Wired kind "${kind}" has no positive expectation or detector_silent entry in golden-bugs.jsonl`);
    }
  }

  for (const kind of deferredKinds) {
    if (!goldenNegativeKinds.has(kind) && !manifestDeferred.has(kind)) {
      errors.push(
        `Deferred kind "${kind}" has no "expect: absent" line in golden-bugs.jsonl and is not listed under reuse-manifest.json.deferred`,
      );
    }
  }

  if (errors.length > 0) {
    throw new LockstepError(
      `Lockstep check failed (${errors.length} issue(s)):\n${errors.map(e => `  - ${e}`).join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Expectation evaluation (§6.1)
// ---------------------------------------------------------------------------

export function evaluateExpectations(
  clusters: BugCluster[],
  goldenLines: GoldenLine[],
  opts: { failOnFlake: boolean },
): Omit<SelfTestResult, 'elapsedMs' | 'budgetMs' | 'budgetOk' | 'passed'> {
  const positiveExpectations = goldenLines.filter(
    (l): l is PositiveExpectation => !('expect' in l),
  );
  // Both 'absent' and 'detector_silent' lines assert the kind must NOT appear in results.
  const negativeExpectations = goldenLines.filter(
    (l): l is NegativeExpectation => 'expect' in l && l.expect === 'absent',
  );
  const silentKinds = new Set(
    goldenLines
      .filter((l): l is DetectorSilentExpectation => 'expect' in l && l.expect === 'detector_silent')
      .map(l => l.kind),
  );

  const goldenKinds = new Set(positiveExpectations.map(e => e.kind));
  const wiredKinds = new Set(
    DETECTOR_REGISTRY.filter(r => r.status === 'wired').map(r => r.kind),
  );

  const positiveResults: SelfTestResult['positives'] = [];
  const negativeResults: SelfTestResult['negatives'] = [];
  const unexpectedKinds: BugKind[] = [];

  for (const exp of positiveExpectations) {
    const matched = clusters.filter(c => {
      if (c.kind !== exp.kind) return false;
      const sig = c.signatureKey ?? '';
      if (!sig.startsWith(exp.signaturePrefix)) return false;
      if (exp.rootCauseSubstring !== undefined) {
        if (!c.rootCause.toLowerCase().includes(exp.rootCauseSubstring.toLowerCase())) return false;
      }
      return true;
    });
    const matchedSize = matched.reduce((n, c) => n + c.clusterSize, 0);
    const required = exp.minClusterSize ?? 1;
    const pass = matchedSize >= required;

    if (pass) {
      positiveResults.push({ kind: exp.kind, expected: required, matched: matchedSize, status: 'PASS' });
    } else if (!opts.failOnFlake && (exp.acceptableMisses ?? 0) >= 1) {
      positiveResults.push({ kind: exp.kind, expected: required, matched: matchedSize, status: 'FLAKED' });
    } else {
      positiveResults.push({ kind: exp.kind, expected: required, matched: matchedSize, status: 'MISS' });
    }
  }

  for (const exp of negativeExpectations) {
    const found = clusters.filter(c => c.kind === exp.kind);
    if (found.length === 0) {
      negativeResults.push({ kind: exp.kind, observed: 0, status: 'PASS' });
    } else {
      negativeResults.push({ kind: exp.kind, observed: found.length, status: 'FALSE_POSITIVE' });
    }
  }

  // Unexpected: wired clusters not in golden positive or detector_silent expectations
  const observedKinds = new Set(clusters.map(c => c.kind));
  for (const kind of observedKinds) {
    if (wiredKinds.has(kind) && !goldenKinds.has(kind) && !silentKinds.has(kind)) {
      unexpectedKinds.push(kind);
    }
  }

  return { positives: positiveResults, negatives: negativeResults, unexpectedKinds };
}

// ---------------------------------------------------------------------------
// Fixture boot/teardown
// ---------------------------------------------------------------------------

function spawnScript(scriptPath: string): void {
  const result = child_process.spawnSync('bash', [scriptPath], {
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new SelfTestSetupError(
      `Fixture script "${scriptPath}" exited with code ${String(result.status)}. ` +
      'Check that all sub-fixture ports are free and dependencies installed.',
    );
  }
}

// ---------------------------------------------------------------------------
// Result emission
// ---------------------------------------------------------------------------

function emitHumanResult(result: SelfTestResult): void {
  const { positives, negatives, unexpectedKinds, elapsedMs, budgetMs, budgetOk } = result;

  process.stdout.write('\n=== BugHunter Self-Test Results ===\n\n');
  process.stdout.write('Positive expectations:\n');
  for (const p of positives) {
    const marker = p.status === 'PASS' ? 'PASS' : p.status === 'FLAKED' ? 'FLAKED' : 'MISS';
    process.stdout.write(`  [${marker}] ${p.kind}  (matched=${p.matched}, required=${p.expected})\n`);
  }

  process.stdout.write('\nNegative expectations:\n');
  for (const n of negatives) {
    const marker = n.status === 'PASS' ? 'PASS' : 'FALSE_POSITIVE';
    process.stdout.write(`  [${marker}] ${n.kind}  (observed=${n.observed})\n`);
  }

  if (unexpectedKinds.length > 0) {
    process.stdout.write('\nUnexpected kinds (informational):\n');
    for (const k of unexpectedKinds) {
      process.stdout.write(`  [INFO] ${k}\n`);
    }
  }

  process.stdout.write(`\nWallclock: ${elapsedMs}ms / budget ${budgetMs}ms  [${budgetOk ? 'OK' : 'EXCEEDED'}]\n`);
  process.stdout.write(`\nResult: ${result.passed ? 'PASSED' : 'FAILED'}\n\n`);
}

function appendPerfHistory(fixtureRoot: string, elapsedMs: number): void {
  const perfFile = path.join(fixtureRoot, '.bughunter', 'perf-history.jsonl');
  const existing = fs.existsSync(perfFile)
    ? fs.readFileSync(perfFile, 'utf-8').split('\n').filter(l => l.trim().length > 0)
    : [];
  const trimmed = existing.slice(-99); // keep last 99, then append new → 100 max
  const entry = JSON.stringify({ ts: new Date().toISOString(), elapsedMs });
  fs.mkdirSync(path.dirname(perfFile), { recursive: true });
  fs.writeFileSync(perfFile, `${[...trimmed, entry].join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function selfTestCommand(opts: SelfTestOptions): Promise<void> {
  const budgetMs = opts.budgetMs ?? 1_800_000;

  const fixtureRoot = fixtureRootFor(opts.projectDir);
  const manifest = readManifest(fixtureRoot);
  const goldenLines = readGolden(fixtureRoot);

  // Fail fast on drift before booting anything (exit code 2)
  try {
    assertLockstep(manifest, goldenLines);
  } catch (err) {
    if (err instanceof LockstepError) {
      process.stderr.write(`\n[self-test] LOCKSTEP ERROR:\n${err.message}\n\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const upScript = path.join(fixtureRoot, 'bin', 'up.sh');
  const downScript = path.join(fixtureRoot, 'bin', 'down.sh');

  if (opts.skipFixtureUp !== true) {
    spawnScript(upScript);
  }

  let result: SelfTestResult;

  try {
    const startedAt = Date.now();

    await runCommand({
      projectDir: fixtureRoot,
      maxBugs: opts.maxBugs ?? 400,
      budget: budgetMs,
      a11y: true,
      a11yStrict: true,
      seoEnabled: true,
      enablePerf: true,
      enableBundleProbe: true,
      enableMemoryProfile: true,
      raceConditions: true,
      raceCrossTab: true,
      idor: true,
    });

    const elapsedMs = Date.now() - startedAt;
    const runId = latestRunId(fixtureRoot);
    const clusters = readBugsJsonl(fixtureRoot, runId);
    const failOnFlake = opts.failOnFlake !== false;

    const evaluation = evaluateExpectations(clusters, goldenLines, { failOnFlake });

    const allPositivesMet = evaluation.positives.every(
      p => p.status === 'PASS' || p.status === 'FLAKED',
    );
    const allNegativesMet = evaluation.negatives.every(n => n.status === 'PASS');
    const budgetOk = elapsedMs <= budgetMs;

    result = {
      passed: allPositivesMet && allNegativesMet && budgetOk,
      elapsedMs,
      budgetMs,
      budgetOk,
      ...evaluation,
    };

    appendPerfHistory(fixtureRoot, elapsedMs);
  } finally {
    if (opts.skipFixtureUp !== true) {
      try {
        spawnScript(downScript);
      } catch {
        process.stderr.write('[self-test] Warning: down.sh failed; stray fixture processes may remain.\n');
      }
    }
  }

  if (opts.jsonOutput === true) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    emitHumanResult(result);
  }

  if (!result.passed) {
    process.exitCode = 1;
  }
}
