// Pure fix-summary computation — extracted from cli/fix-summary.ts so the MCP
// write-side can return the same counters as the CLI print path.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type FixStateEntry = {
  clusterId: string;
  verdict: string;
  detail?: string;
  paths?: string[];
};

export type Counters = {
  bugs_filed: number;
  bugs_architect_refused: number;
  bugs_attempted_fix: number;
  bugs_verified_fixed: number;
  partially_verified: number;
  bugs_persistent: number;
  bugs_skipped: number;
  bugs_lost_to_revision: number;
};

export type FixSummary = {
  entries: FixStateEntry[];
  counters: Counters;
};

export function tally(entries: FixStateEntry[]): Counters {
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

export function computeFixSummary(projectDir: string, runId: string): FixSummary | null {
  const fixStatePath = path.join(projectDir, '.bughunter', 'runs', runId, 'fix-state.json');
  if (!fs.existsSync(fixStatePath)) return null;
  const entries = JSON.parse(fs.readFileSync(fixStatePath, 'utf-8')) as FixStateEntry[];
  return { entries, counters: tally(entries) };
}
