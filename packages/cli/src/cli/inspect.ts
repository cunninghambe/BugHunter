// bughunter inspect <occurrenceId|clusterId> — prints cluster summary + artifact paths.

import { loadConfig } from '../config.js';
import { listRunIds, runPaths, readJsonFile } from '../store/filesystem.js';
import type { BugCluster, Occurrence, OccurrenceFull } from '../types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../log.js';

export function inspectCommand(projectDir: string, id: string): void {
  const runIds = listRunIds(projectDir);

  for (const runId of runIds) {
    const paths = runPaths(projectDir, runId);
    if (!fs.existsSync(paths.bugsFile)) continue;

    const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const cluster = JSON.parse(line) as BugCluster;

      // Match by cluster id or occurrence id
      const matchesCluster = cluster.id === id;
      const matchingOcc = cluster.occurrences.find(o => o.occurrenceId === id);

      if (!matchesCluster && !matchingOcc) continue;

      printCluster(cluster, matchingOcc ?? null);
      return;
    }
  }

  log.error(`No cluster or occurrence found with id: ${id}`);
  process.exitCode = 1;
}

function printCluster(cluster: BugCluster, focusOcc: Occurrence | null): void {
  const relatedLine = cluster.relatedClusterIds?.length
    ? [`Related clusters: ${cluster.relatedClusterIds.join(', ')}`]
    : [];

  const lines = [
    `\n=== Bug Cluster ${cluster.id} ===`,
    `Kind: ${cluster.kind}`,
    `Root Cause: ${cluster.rootCause}`,
    `Cluster Size: ${cluster.clusterSize}`,
    `First Seen: ${cluster.firstSeenAt}`,
    `Last Seen: ${cluster.lastSeenAt}`,
    `Suspected Files: ${cluster.suspectedFiles.join(', ') || '(none)'}`,
    `Third Party: ${cluster.thirdPartyOrGenerated}`,
    ...relatedLine,
    '',
    'Fix Hints:',
    ...cluster.fixHints.map(h => `  - ${h}`),
    '',
    `Occurrences (${cluster.occurrences.length}):`,
  ];

  const occs = focusOcc ? [focusOcc] : cluster.occurrences;
  for (const occ of occs) {
    lines.push(`  [${occ.occurrenceId}] role=${occ.role} page=${occ.page} fullArtifacts=${occ.fullArtifacts}`);
    if (occ.fullArtifacts) {
      const full = occ as OccurrenceFull;
      lines.push(`    Screenshot: ${full.screenshotPath}`);
      lines.push(`    DOM: ${full.domSnapshotPath}`);
      lines.push(`    Console: ${full.consoleLogPath}`);
      lines.push(`    Network: ${full.networkLogPath}`);
      lines.push(`    Action Log: ${full.actionLogPath}`);
      lines.push(`    Replay: ${full.replayCommand}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}
