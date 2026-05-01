// v0.29: RFC 4180 CSV emitter.
// Spec §4.5: always wrap fields in double-quotes; embed quotes are doubled; newlines replaced.

import type { BugCluster } from '../types.js';
import type { DetectorMetadata } from '../detectors/registry.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';
import { severityForCluster } from './severity.js';

type RegistryLookup = Record<string, DetectorMetadata | undefined>;

const HEADER = 'id,kind,severity,cwe,root_cause,cluster_size,first_seen,last_seen,suspected_files,verdict,replay_command,run_id';

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildRow(cluster: BugCluster): string {
  const severity = severityForCluster(cluster);
  const registry: RegistryLookup = DETECTOR_REGISTRY_MAP;
  const meta = registry[cluster.kind];
  const cwe = (meta?.cwe ?? []).join(';');
  const rootCause = cluster.rootCause.replace(/\n/g, ' ').slice(0, 500);
  const suspectedFiles = cluster.suspectedFiles.join(';');
  const replayCmd = cluster.occurrences[0]?.fullArtifacts ? cluster.occurrences[0].replayCommand : '';
  const verdict = cluster.verdict ?? '';

  const cells = [
    cluster.id,
    cluster.kind,
    severity,
    cwe,
    rootCause,
    String(cluster.clusterSize),
    cluster.firstSeenAt,
    cluster.lastSeenAt,
    suspectedFiles,
    verdict,
    replayCmd,
    cluster.runId,
  ];
  return cells.map(csvCell).join(',');
}

export function renderCsv(clusters: BugCluster[]): string {
  const rows = [HEADER, ...clusters.map(buildRow)];
  return `${rows.join('\r\n')}\r\n`;
}
