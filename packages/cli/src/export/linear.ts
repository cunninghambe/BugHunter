// v0.29: Linear IssueCreateInput[] emitter.
// Emits JSON array; caller POSTs each draft (out of scope for v0.29).

import type { BugCluster, BugKind, Severity } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { DetectorMetadata } from '../detectors/registry.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';
import { severityForCluster, severityToLinearPriority } from './severity.js';

const DESC_MAX = 32 * 1024;
const TRUNCATE_SUFFIX = '\n…(truncated; see SARIF for full detail)';

type RegistryLookup = Record<string, DetectorMetadata | undefined>;

export type LinearIssueDraft = {
  title: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
  labelIds?: string[];
  bughunter: {
    runId: string;
    clusterId: string;
    kind: BugKind;
    severity: Severity;
    cwe: string[];
    suspectedFiles: string[];
    replayCommand: string | undefined;
  };
};

function buildDescription(cluster: BugCluster, replayCmd: string | undefined): string {
  const files = cluster.suspectedFiles.length > 0
    ? cluster.suspectedFiles.map(f => `- ${suspectedFilePath(f)}`).join('\n')
    : '- (none)';
  const hints = cluster.fixHints.length > 0
    ? cluster.fixHints.map(h => `- ${h}`).join('\n')
    : '- (none)';

  const sections = [
    `### Summary\n\n${cluster.rootCause}`,
    `### Suspected Files\n\n${files}`,
    ...(replayCmd !== undefined ? [`### Replay Command\n\n\`\`\`sh\n${replayCmd}\n\`\`\``] : []),
    `### Fix Hints\n\n${hints}`,
    `### Cluster Metadata\n\n| Field | Value |\n|---|---|\n| ID | ${cluster.id} |\n| Kind | ${cluster.kind} |\n| Size | ${cluster.clusterSize} |\n| First seen | ${cluster.firstSeenAt} |\n| Last seen | ${cluster.lastSeenAt} |`,
  ];

  const md = sections.join('\n\n');
  if (md.length > DESC_MAX) {
    return `${md.slice(0, DESC_MAX - TRUNCATE_SUFFIX.length)}${TRUNCATE_SUFFIX}`;
  }
  return md;
}

export function renderLinear(clusters: BugCluster[]): LinearIssueDraft[] {
  const registry: RegistryLookup = DETECTOR_REGISTRY_MAP;
  return clusters.map(cluster => {
    const severity = severityForCluster(cluster);
    const meta = registry[cluster.kind];
    const replayCmd = cluster.occurrences[0]?.fullArtifacts ? cluster.occurrences[0].replayCommand : undefined;
    const rootCauseSnippet = cluster.rootCause.slice(0, 80);
    const title = `[BugHunter ${severity}] ${cluster.kind}: ${rootCauseSnippet}`;

    return {
      title,
      description: buildDescription(cluster, replayCmd),
      priority: severityToLinearPriority(severity),
      bughunter: {
        runId: cluster.runId,
        clusterId: cluster.id,
        kind: cluster.kind,
        severity,
        cwe: meta?.cwe ?? [],
        suspectedFiles: cluster.suspectedFiles.map(suspectedFilePath),
        replayCommand: replayCmd,
      },
    };
  });
}
