// bughunter coverage — read and pretty-print coverage.json for a run.

import * as fs from 'node:fs';
import { listRunIds, runPaths } from '../store/filesystem.js';
import type { Coverage, CoverageEntry, CoverageStatus } from '../phases/coverage.js';
import type { BugKind } from '../types.js';

export type CoverageCommandOptions = {
  latest?: boolean;
  json?: boolean;
  dead?: boolean;
  kind?: string;
  verbose?: boolean;
};

function loadCoverage(projectDir: string, runId: string): Coverage {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.coverageFile)) {
    const err = new Error(`coverage.json missing for run ${runId} (run predates V34)`);
    (err as Error & { code: string }).code = 'coverage_unavailable';
    throw err;
  }
  return JSON.parse(fs.readFileSync(paths.coverageFile, 'utf-8')) as Coverage;
}

function resolveRunId(projectDir: string, runId: string | undefined, latest: boolean): string {
  if (latest) {
    const runIds = listRunIds(projectDir).sort().reverse();
    if (runIds.length === 0) {
      const err = new Error('No BugHunter runs found for project');
      (err as Error & { code: string }).code = 'coverage_unavailable';
      throw err;
    }
    return runIds[0];
  }
  if (runId === undefined || runId === '') {
    throw new Error('Usage: bughunter coverage <runId> [--latest] [--json] [--dead] [--kind <kind>] [--verbose]');
  }
  return runId;
}

function bucketEntries(coverage: Coverage): Map<CoverageStatus, Array<[BugKind, CoverageEntry]>> {
  const buckets = new Map<CoverageStatus, Array<[BugKind, CoverageEntry]>>([
    ['fired', []],
    ['input-absent', []],
    ['detector-dead', []],
    ['detector-deferred', []],
  ]);
  const kinds = (Object.keys(coverage.byKind) as BugKind[]).sort();
  for (const kind of kinds) {
    const entry = coverage.byKind[kind];
    const bucket = buckets.get(entry.status);
    if (bucket !== undefined) {
      bucket.push([kind, entry]);
    }
  }
  return buckets;
}

function formatDeadBucket(entries: Array<[BugKind, CoverageEntry]>): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [`\nDetector dead (${entries.length}):`];
  for (const [kind] of entries) {
    lines.push(`  ${kind.padEnd(45)} — wired=false in registry  (file BugHunter issue)`);
  }
  return lines;
}

function formatDeferredBucket(entries: Array<[BugKind, CoverageEntry]>): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [`\nDeferred (${entries.length}):`];
  for (const [kind, entry] of entries) {
    const target = entry.deferredTo !== undefined ? `→ ${entry.deferredTo}` : '→ (no target spec)';
    const note = entry.reason !== undefined ? ` (${entry.reason})` : '';
    lines.push(`  ${kind.padEnd(45)} ${target}${note}`);
  }
  return lines;
}

function formatInputAbsentBucket(entries: Array<[BugKind, CoverageEntry]>, verbose: boolean): string[] {
  if (entries.length === 0) return [];
  if (!verbose) {
    return [`\nInput absent (${entries.length}) — pass --verbose to list.`];
  }
  const lines: string[] = [`\nInput absent (${entries.length}):`];
  for (const [kind] of entries) {
    lines.push(`  ${kind}`);
  }
  return lines;
}

function formatFiredBucket(entries: Array<[BugKind, CoverageEntry]>, verbose: boolean): string[] {
  if (entries.length === 0) return [];
  if (!verbose) {
    return [`\nFired (${entries.length}) — pass --verbose to list with cluster counts.`];
  }
  const lines: string[] = [`\nFired (${entries.length}):`];
  for (const [kind, entry] of entries) {
    lines.push(`  ${kind.padEnd(45)} clusters=${entry.clustersEmitted}`);
  }
  return lines;
}

function printKindDetail(coverage: Coverage, kindName: string): void {
  const entry = (coverage.byKind as Partial<Record<string, CoverageEntry>>)[kindName];
  if (entry === undefined) {
    process.stderr.write(`Unknown BugKind: ${kindName}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ kind: kindName, ...entry }, null, 2)}\n`);
}

function prettyPrint(coverage: Coverage, opts: CoverageCommandOptions): void {
  const { summary } = coverage;
  const buckets = bucketEntries(coverage);

  if (opts.dead === true) {
    const dead = buckets.get('detector-dead') ?? [];
    const lines = formatDeadBucket(dead);
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const header = [
    `\n=== Coverage for run ${coverage.runId} ===`,
    `Total kinds:    ${summary.kindsTotal}`,
    `Fired:          ${summary.kindsWiredAndFired}  (detector wired, input observed)`,
    `Input absent:   ${summary.kindsWiredButInputAbsent}  (detector wired, no input — opt-in subsystem off, or SPA didn't exhibit input)`,
    `Detector dead:   ${summary.kindsDead}  (BugHunter bug — please file an issue)`,
    `Deferred:       ${summary.kindsDeferred}  (advertised gap, see deferredTo column)`,
  ];

  const dead = formatDeadBucket(buckets.get('detector-dead') ?? []);
  const deferred = formatDeferredBucket(buckets.get('detector-deferred') ?? []);
  const absent = formatInputAbsentBucket(buckets.get('input-absent') ?? [], opts.verbose === true);
  const fired = formatFiredBucket(buckets.get('fired') ?? [], opts.verbose === true);

  const lines = [...header, ...dead, ...deferred, ...absent, ...fired, ''];
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function coverageCommand(
  projectDir: string,
  runId: string | undefined,
  opts: CoverageCommandOptions,
): void {
  try {
    const resolvedRunId = resolveRunId(projectDir, runId, opts.latest === true);
    const coverage = loadCoverage(projectDir, resolvedRunId);

    if (opts.kind !== undefined) {
      printKindDetail(coverage, opts.kind);
      return;
    }

    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(coverage, null, 2)}\n`);
      return;
    }

    prettyPrint(coverage, opts);
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'coverage_unavailable';
    process.stderr.write(`${JSON.stringify({ code, message: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  }
}
