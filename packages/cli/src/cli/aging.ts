// bughunter aging — list clusters open for >= N days without a fix.

import { openHistoryDb, agingClusters } from '../store/history.js';
import { historyDbPath } from '../store/filesystem.js';
import { loadConfig } from '../config.js';
import * as fs from 'node:fs';

export function agingCommand(
  projectDir: string,
  opts: {
    thresholdDays?: number;
    minRuns?: number;
  },
): void {
  if (!fs.existsSync(historyDbPath(projectDir))) {
    process.stdout.write('No history found. Run `bughunter run` first to build history.db.\n');
    return;
  }

  const config = loadConfig(projectDir);
  const thresholdDays = opts.thresholdDays ?? 7;
  const minRuns = opts.minRuns ?? 3;

  const db = openHistoryDb(projectDir);
  try {
    const rows = agingClusters(db, config.projectName, thresholdDays, minRuns);
    if (rows.length === 0) {
      process.stdout.write(`No clusters open >= ${thresholdDays} days across >= ${minRuns} runs.\n`);
      return;
    }

    const lines = [
      `\n=== Aging clusters (project: ${config.projectName}, threshold: ${thresholdDays}d, min-runs: ${minRuns}) ===`,
      `${'IDENTITY'.padEnd(18)}  ${'KIND'.padEnd(32)}  ${'FIRST_SEEN'.padEnd(24)}  ${'LAST_SEEN'.padEnd(24)}  ${'DAYS'.padEnd(5)}  RUNS`,
      '-'.repeat(120),
    ];
    for (const r of rows) {
      const daysOpen = Math.round(
        (new Date(r.last_seen).getTime() - new Date(r.first_seen).getTime()) / (1000 * 60 * 60 * 24),
      );
      lines.push(
        `${r.bug_identity.padEnd(18)}  ${r.kind.padEnd(32)}  ${r.first_seen.padEnd(24)}  ${r.last_seen.padEnd(24)}  ${String(daysOpen).padEnd(5)}  ${r.run_count}`,
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
}
