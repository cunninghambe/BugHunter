// v0.35: append-only JSON log for bisect per-commit entries + final report renderer.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BisectLogEntry, BisectRunSummary } from '../../types.js';

/** Append one per-commit entry to the bisect log file. */
export function appendBisectLog(logPath: string, entry: BisectLogEntry): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

/** Read all log entries from a bisect log file. */
export function readBisectLog(logPath: string): BisectLogEntry[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as BisectLogEntry);
}

/** Render the final bisect report as text. */
export function renderBisectReport(summary: BisectRunSummary, _logEntries: BisectLogEntry[]): string {
  const lines: string[] = [];
  const sep = '='.repeat(78);

  lines.push(sep);
  if (summary.status === 'found' && summary.introducingCommit !== undefined) {
    const c = summary.introducingCommit;
    lines.push(`Introducing commit: ${c.sha.slice(0, 7)}`);
    lines.push(`Author: ${c.author}`);
    lines.push(`Date:   ${c.date}`);
    lines.push(`Subject: ${c.subject}`);
  } else if (summary.status === 'all_skipped') {
    lines.push('Introducing commit: unknown — all commits were skipped');
    lines.push('  Check .bughunter/bisect-runs/ commit logs for root causes.');
  } else if (summary.status === 'not_found') {
    lines.push('Introducing commit: not found in the searched range.');
  } else if (summary.status === 'preflight_failed') {
    lines.push('Bisect aborted: pre-flight check failed.');
  } else {
    lines.push('Bisect aborted.');
  }

  lines.push('');
  lines.push(`Action log replayed: ${summary.occurrenceId}`);
  lines.push(`Commits tested: ${summary.commitsVisited} (skipped: ${summary.commitsSkipped})`);
  const secs = Math.round(summary.durationMs / 1000);
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  lines.push(`Total time: ${mins}m${remSecs}s`);
  lines.push(`Bisect log: ${summary.bisectLogPath}`);
  lines.push(sep);

  return lines.join('\n');
}

/** Render a per-commit progress line. */
export function renderCommitProgress(
  sha: string,
  visited: number,
  total: number,
  phase: string,
): string {
  return `Visiting ${sha.slice(0, 7)} (${visited}/${total})... ${phase}`;
}
