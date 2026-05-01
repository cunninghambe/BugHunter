// v0.29: summary.md renderer for bughunter ci.
// Spec §6.5 exact template. Pure function — no I/O.

import type { BugCluster, Severity } from '../types.js';
import { severityForCluster } from './severity.js';
import type { DiffSummary, FailOnRule } from './fail-on.js';
import { describeFailOn } from './fail-on.js';

const MAX_BYTES = 8 * 1024;

export type SummaryMdOptions = {
  runId: string;
  clusters: BugCluster[];
  bySeverity: Record<Severity, number>;
  byKind: Record<string, number>;
  runtimeMs: number;
  reportPath: string;
  diff: DiffSummary | null;
  diffRunId: string | undefined;
  failOnRule: FailOnRule;
  breached: boolean;
};

function topFindings(clusters: BugCluster[]): BugCluster[] {
  const SEVERITY_ORDER: Severity[] = ['critical', 'major', 'minor', 'info'];
  return [...clusters]
    .sort((a, b) => {
      const ai = SEVERITY_ORDER.indexOf(severityForCluster(a));
      const bi = SEVERITY_ORDER.indexOf(severityForCluster(b));
      return ai - bi;
    })
    .slice(0, 10);
}

export function renderSummaryMd(opts: SummaryMdOptions): string {
  const {
    runId, clusters, bySeverity, byKind, runtimeMs,
    reportPath, diff, diffRunId, failOnRule, breached,
  } = opts;

  const exitIcon = breached ? '❌' : '✅';
  const passLabel = breached ? 'FAILED' : 'PASSED';
  const seconds = Math.round(runtimeMs / 1000);

  const severityTable = [
    '| Severity | Count |',
    '|---|---|',
    `| Critical | ${bySeverity.critical} |`,
    `| Major | ${bySeverity.major} |`,
    `| Minor | ${bySeverity.minor} |`,
    `| Info | ${bySeverity.info} |`,
  ].join('\n');

  const top = topFindings(clusters);
  const topRows = top.map(c => {
    const sev = severityForCluster(c);
    const file = c.suspectedFiles[0] ?? 'unknown';
    const desc = c.rootCause.slice(0, 60);
    return `| \`${c.id.slice(0, 8)}\` | ${c.kind} | ${sev} | ${file} | ${desc} |`;
  }).join('\n');

  const byKindEntries = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const byKindRows = byKindEntries
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');

  let diffSection = '';
  if (diff !== null && diffRunId !== undefined) {
    const newIds = diff.added.slice(0, 5).map(c => `\`${c.id.slice(0, 8)}\``).join(', ');
    const newIdsStr = newIds.length > 0 ? ` (${newIds})` : '';
    diffSection = [
      `### Diff vs \`${diffRunId}\``,
      '',
      `- **New:** ${diff.added.length}${newIdsStr}`,
      `- **Regressed:** ${diff.regressed.length}`,
    ].join('\n');
  }

  const topRowsStr = topRows.length > 0 ? topRows : '| — | — | — | — | — |';
  const byKindRowsStr = byKindRows.length > 0 ? byKindRows : '| — | — |';

  const parts = [
    `## BugHunter Run \`${runId}\``,
    '',
    `**Result:** ${exitIcon} ${passLabel}`,
    `**Failed gate:** ${describeFailOn(failOnRule)}`,
    `**Total clusters:** ${clusters.length}`,
    `**Runtime:** ${seconds}s`,
    '',
    '### By severity',
    '',
    severityTable,
    ...(diffSection.length > 0 ? ['', diffSection] : []),
    '',
    '### Top findings',
    '',
    '| Cluster | Kind | Severity | File | Description |',
    '|---|---|---|---|---|',
    topRowsStr,
    '',
    '<details>',
    '<summary>By kind</summary>',
    '',
    '| Kind | Count |',
    '|---|---|',
    byKindRowsStr,
    '',
    '</details>',
    '',
    `— Full SARIF: \`${reportPath}\``,
    '— Replay any cluster: `bughunter replay <occurrenceId>`',
  ];

  let md = parts.join('\n');
  if (md.length > MAX_BYTES) {
    md = `${md.slice(0, MAX_BYTES - 30)}\n\n…(summary truncated)\n`;
  }
  return md;
}
