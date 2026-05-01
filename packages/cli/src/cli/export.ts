// bughunter export <runId> --format <fmt> [options]

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugCluster } from '../types.js';
import type { ExportFormat } from '../export/index.js';
import { runExport, defaultExtension } from '../export/index.js';
import { runPaths } from '../store/filesystem.js';
import { severityForCluster, severityAtLeast } from '../export/severity.js';
import type { Severity } from '../types.js';

const VALID_FORMATS: ExportFormat[] = ['sarif', 'github', 'gitlab', 'csv', 'linear', 'jira'];

export type ExportCommandOptions = {
  runId: string;
  format: ExportFormat;
  out?: string;
  severityMin?: Severity;
  truncate?: number;
  noThirdParty?: boolean;
};

function readClusters(bugsFile: string): BugCluster[] {
  if (!fs.existsSync(bugsFile)) return [];
  const lines = fs.readFileSync(bugsFile, 'utf-8').split('\n').filter(Boolean);
  return lines.map(l => JSON.parse(l) as BugCluster);
}

export function exportCommand(
  projectDir: string,
  opts: ExportCommandOptions,
): void {
  const { runId, format, severityMin = 'info', truncate = 5000, noThirdParty = false } = opts;

  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.runDir)) {
    process.stderr.write(`Run not found: ${runId}\n`);
    process.exit(3);
  }

  let clusters = readClusters(paths.bugsFile);

  if (noThirdParty) {
    clusters = clusters.filter(c => !c.thirdPartyOrGenerated);
  }

  if (severityMin !== 'info') {
    clusters = clusters.filter(c => severityAtLeast(severityForCluster(c), severityMin));
  }

  let stateStartedAt = new Date().toISOString();
  const stateFile = paths.stateFile;
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { startedAt?: string };
      if (state.startedAt !== undefined) stateStartedAt = state.startedAt;
    } catch {
      // fall through — use current time
    }
  }

  const result = runExport({
    format,
    clusters,
    state: { runId, startedAt: stateStartedAt, projectDir },
    truncateAt: truncate,
  });

  if (!result.ok) {
    process.stderr.write(`Export failed: ${result.reason}\n`);
    process.exit(4);
  }

  const outPath = opts.out ?? path.join(paths.exportsDir, `${format}.${defaultExtension(format)}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, result.content, 'utf-8');

  process.stdout.write(`Exported ${clusters.length} clusters to ${outPath}\n`);
  if (result.truncated) {
    process.stdout.write(`(Truncated to ${truncate} results)\n`);
  }
}

export function parseExportArgs(
  args: string[],
  flags: Record<string, string | boolean>,
): ExportCommandOptions {
  const runId = args[0] ?? '';
  if (runId === '') {
    process.stderr.write('Usage: bughunter export <runId> --format <fmt>\n');
    process.exit(2);
  }

  const format = typeof flags['format'] === 'string' ? flags['format'] : '';
  if (!VALID_FORMATS.includes(format as ExportFormat)) {
    process.stderr.write(`Invalid --format: ${format}. Valid values: ${VALID_FORMATS.join(', ')}\n`);
    process.exit(2);
  }

  const severityMin = typeof flags['severity-min'] === 'string'
    ? (flags['severity-min'] as Severity)
    : undefined;

  const truncate = typeof flags['truncate'] === 'string'
    ? parseInt(flags['truncate'], 10)
    : undefined;

  return {
    runId,
    format: format as ExportFormat,
    out: typeof flags['out'] === 'string' ? flags['out'] : undefined,
    severityMin,
    truncate,
    noThirdParty: flags['no-third-party'] === true,
  };
}
