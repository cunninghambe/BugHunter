// bughunter fix-summary — pretty-prints per-cluster verdict table (§ 3.9.1, § 3.9.6).
// Reads .bughunter/runs/<runId>/fix-state.json written by the /bughunt fix skill.

import * as fs from 'node:fs';
import * as path from 'node:path';

type FixStateEntry = {
  clusterId: string;
  verdict: string;
  detail?: string;
  paths?: string[];
};

type Counters = {
  bugs_filed: number;
  bugs_architect_refused: number;
  bugs_attempted_fix: number;
  bugs_verified_fixed: number;
  partially_verified: number;
  bugs_persistent: number;
  bugs_skipped: number;
  bugs_lost_to_revision: number;
};

function tally(entries: FixStateEntry[]): Counters {
  const c: Counters = {
    bugs_filed: entries.length,
    bugs_architect_refused: 0,
    bugs_attempted_fix: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
  };

  for (const e of entries) {
    switch (e.verdict) {
      case 'architect_refused':
        c.bugs_architect_refused++;
        c.bugs_skipped++;
        break;
      case 'touched_forbidden_path':
        c.bugs_skipped++;
        break;
      case 'verified_fixed':
      case 'verified_fixed_by_removal':
        c.bugs_attempted_fix++;
        c.bugs_verified_fixed++;
        break;
      case 'partially_verified':
        c.bugs_attempted_fix++;
        c.partially_verified++;
        break;
      case 'not_fixed':
        c.bugs_attempted_fix++;
        c.bugs_persistent++;
        break;
      case 'bugs_lost_to_revision':
        c.bugs_attempted_fix++;
        c.bugs_lost_to_revision++;
        break;
      case 'verified_fixed_static':
        c.bugs_attempted_fix++;
        c.bugs_verified_fixed++;
        break;
      case 'partially_verified_static':
        c.bugs_attempted_fix++;
        c.partially_verified++;
        break;
      case 'not_fixed_static':
        c.bugs_attempted_fix++;
        c.bugs_persistent++;
        break;
      case 'cannot_retest':
        c.bugs_skipped++;
        break;
    }
  }

  return c;
}

export function fixSummaryCommand(projectDir: string, runId: string): void {
  const fixStatePath = path.join(projectDir, '.bughunter', 'runs', runId, 'fix-state.json');

  if (!fs.existsSync(fixStatePath)) {
    process.stdout.write('no fix run yet\n');
    return;
  }

  const entries = JSON.parse(fs.readFileSync(fixStatePath, 'utf-8')) as FixStateEntry[];
  const counters = tally(entries);

  const col1 = Math.max(12, ...entries.map(e => e.clusterId.length));
  const col2 = 28;

  const header = `${'CLUSTER'.padEnd(col1)}  ${'VERDICT'.padEnd(col2)}  DETAIL`;
  const divider = '-'.repeat(header.length);

  process.stdout.write(`\n${header}\n${divider}\n`);
  for (const e of entries) {
    const detail = e.paths?.join(', ') ?? e.detail ?? '';
    process.stdout.write(`${e.clusterId.padEnd(col1)}  ${e.verdict.padEnd(col2)}  ${detail}\n`);
  }

  process.stdout.write(`\n${divider}\n`);
  process.stdout.write(`bugs_filed:             ${counters.bugs_filed}\n`);
  process.stdout.write(`bugs_architect_refused: ${counters.bugs_architect_refused}\n`);
  process.stdout.write(`bugs_attempted_fix:     ${counters.bugs_attempted_fix}\n`);
  process.stdout.write(`bugs_verified_fixed:    ${counters.bugs_verified_fixed}\n`);
  process.stdout.write(`partially_verified:     ${counters.partially_verified}\n`);
  process.stdout.write(`bugs_persistent:        ${counters.bugs_persistent}\n`);
  process.stdout.write(`bugs_skipped:           ${counters.bugs_skipped}\n`);
  process.stdout.write(`bugs_lost_to_revision:  ${counters.bugs_lost_to_revision}\n`);
}
