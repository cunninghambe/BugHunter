// bughunter fix-summary — pretty-prints per-cluster verdict table (§ 3.9.1, § 3.9.6).
// Reads .bughunter/runs/<runId>/fix-state.json written by the /bughunt fix skill.

import { computeFixSummary } from '../ops/fix-summary.js';

export function fixSummaryCommand(projectDir: string, runId: string): void {
  const summary = computeFixSummary(projectDir, runId);
  if (summary === null) {
    process.stdout.write('no fix run yet\n');
    return;
  }

  const { entries, counters } = summary;
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
