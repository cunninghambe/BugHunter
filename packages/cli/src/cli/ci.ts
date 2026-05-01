// bughunter ci — CI-friendly subcommand: run + export SARIF + summary.md + exit-code gate.
// Spec §6.1-§6.6.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugCluster, Severity } from '../types.js';
import { runPaths, listRunIds } from '../store/filesystem.js';
import { severityForCluster } from '../export/severity.js';
import { parseFailOn, evaluateFailOn, describeFailOn } from '../export/fail-on.js';
import { renderSarif } from '../export/sarif.js';
import { renderSummaryMd } from '../export/summary-md.js';
import type { RunOptions } from './run.js';
import { runCommand } from './run.js';

export type CiOptions = RunOptions & {
  runId?: string;
  failOn?: string;
  report?: string;
  summaryMd?: string;
  diffAgainst?: string;
  upload?: boolean;
};

function readClusters(bugsFile: string): BugCluster[] {
  if (!fs.existsSync(bugsFile)) return [];
  const lines = fs.readFileSync(bugsFile, 'utf-8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l) as BugCluster);
}

function latestRunId(projectDir: string): string | undefined {
  const ids = listRunIds(projectDir);
  if (ids.length === 0) return undefined;
  return ids
    .map(id => ({
      id,
      mtime: fs.statSync(path.join(projectDir, '.bughunter', 'runs', id)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.id;
}

function buildBySeverity(clusters: BugCluster[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clusters) counts[severityForCluster(c)] += 1;
  return counts;
}

function buildByKind(clusters: BugCluster[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of clusters) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return counts;
}

export async function ciCommand(projectDir: string, opts: CiOptions): Promise<void> {
  const failOnRule = parseFailOn(opts.failOn);

  let runId = opts.runId;
  const startMs = Date.now();

  if (runId === undefined) {
    // Run fresh.
    try {
      await runCommand({ ...opts, projectDir });
    } catch (err) {
      process.stderr.write(`[bughunter ci] Run failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(5);
    }
    runId = latestRunId(projectDir);
    if (runId === undefined) {
      process.stderr.write('[bughunter ci] Run completed but no run directory found\n');
      process.exit(5);
    }
  }

  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.runDir)) {
    process.stderr.write(`[bughunter ci] Run not found: ${runId}\n`);
    process.exit(3);
  }

  // Validate run is complete.
  if (fs.existsSync(paths.stateFile)) {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as { phase?: string; startedAt?: string };
    const phase = state.phase ?? 'unknown';
    if (phase !== 'done' && phase !== 'emit') {
      process.stderr.write(`[bughunter ci] Run not complete: phase=${phase}\n`);
      process.exit(3);
    }
  }

  const clusters = readClusters(paths.bugsFile);
  const runtimeMs = Date.now() - startMs;

  // Diff support (V27 history.db).
  let diff: { added: BugCluster[]; regressed: BugCluster[] } | null = null;
  const diffRunId = opts.diffAgainst;
  if (diffRunId !== undefined) {
    const prevPaths = runPaths(projectDir, diffRunId);
    if (!fs.existsSync(prevPaths.runDir)) {
      process.stderr.write(`[bughunter ci] Diff base run not found: ${diffRunId}\n`);
      process.exit(3);
    }
    diff = computeSimpleDiff(readClusters(prevPaths.bugsFile), clusters);
  }

  // SARIF report.
  let stateStartedAt = new Date().toISOString();
  if (fs.existsSync(paths.stateFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8')) as { startedAt?: string };
      if (s.startedAt !== undefined) stateStartedAt = s.startedAt;
    } catch { /* use default */ }
  }

  const sarif = renderSarif(clusters, { runId, startedAt: stateStartedAt, projectDir });
  const defaultReport = path.join(projectDir, '.bughunter', 'last-report.sarif');
  const reportPath = opts.report ?? defaultReport;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(sarif, null, 2), 'utf-8');

  // Evaluate fail-on.
  const breached = evaluateFailOn(failOnRule, clusters, diff);

  // summary.md.
  const bySeverity = buildBySeverity(clusters);
  const byKind = buildByKind(clusters);
  const defaultSummaryMd = path.join(projectDir, '.bughunter', 'last-report.summary.md');
  const summaryMdPath = opts.summaryMd ?? defaultSummaryMd;
  const md = renderSummaryMd({
    runId,
    clusters,
    bySeverity,
    byKind,
    runtimeMs,
    reportPath,
    diff,
    diffRunId,
    failOnRule,
    breached,
  });
  fs.mkdirSync(path.dirname(summaryMdPath), { recursive: true });
  fs.writeFileSync(summaryMdPath, md, 'utf-8');

  // Write last-run-id (used by GitLab CI template).
  const lastRunIdPath = path.join(projectDir, '.bughunter', 'last-run-id');
  fs.mkdirSync(path.dirname(lastRunIdPath), { recursive: true });
  fs.writeFileSync(lastRunIdPath, runId, 'utf-8');

  process.stdout.write(`[bughunter ci] Run: ${runId}\n`);
  process.stdout.write(`[bughunter ci] ${clusters.length} clusters — gate: ${describeFailOn(failOnRule)}\n`);
  process.stdout.write(`[bughunter ci] SARIF: ${reportPath}\n`);
  process.stdout.write(`[bughunter ci] Summary: ${summaryMdPath}\n`);

  if (opts.upload === true && !breached) {
    const { publishCommand } = await import('./publish.js');
    publishCommand(projectDir, { runId, target: 'github', report: reportPath });
  }

  process.exit(breached ? 1 : 0);
}

function computeSimpleDiff(
  prevClusters: BugCluster[],
  newClusters: BugCluster[],
): { added: BugCluster[]; regressed: BugCluster[] } {
  const prevIds = new Set(prevClusters.map(c => c.signatureKey ?? c.id));
  const prevVerdicts = new Map(prevClusters.map(c => [c.signatureKey ?? c.id, c.verdict]));

  const added: BugCluster[] = [];
  const regressed: BugCluster[] = [];

  for (const c of newClusters) {
    const key = c.signatureKey ?? c.id;
    if (!prevIds.has(key)) {
      added.push(c);
    } else if (prevVerdicts.get(key) === 'verified_fixed') {
      regressed.push(c);
    }
  }
  return { added, regressed };
}
