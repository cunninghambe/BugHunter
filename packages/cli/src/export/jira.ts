// v0.29: Jira issue-draft emitter + Markdown-to-ADF helper.
// ADF: Atlassian Document Format — supports paragraph, heading, bulletList, codeBlock.
// We control the input so a full MD library is not needed.

import type { BugCluster, BugKind, Severity } from '../types.js';
import type { DetectorMetadata } from '../detectors/registry.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';
import { severityForCluster, severityToJiraPriority } from './severity.js';

const DESC_MAX = 32 * 1024;
const TRUNCATE_SUFFIX = '\n…(truncated; see SARIF for full detail)';

type RegistryLookup = Record<string, DetectorMetadata | undefined>;

// ADF types (subset we emit)
type AdfText = { type: 'text'; text: string };
type AdfParagraph = { type: 'paragraph'; content: AdfText[] };
type AdfHeading = { type: 'heading'; attrs: { level: number }; content: AdfText[] };
type AdfListItem = { type: 'listItem'; content: [AdfParagraph] };
type AdfBulletList = { type: 'bulletList'; content: AdfListItem[] };
type AdfCodeBlock = { type: 'codeBlock'; attrs: { language: string }; content: AdfText[] };
type AdfNode = AdfParagraph | AdfHeading | AdfBulletList | AdfCodeBlock;

export type AdfDocument = { version: 1; type: 'doc'; content: AdfNode[] };

function adfText(t: string): AdfText {
  return { type: 'text', text: t };
}
function para(content: string): AdfParagraph {
  return { type: 'paragraph', content: [adfText(content)] };
}
function heading(level: number, content: string): AdfHeading {
  return { type: 'heading', attrs: { level }, content: [adfText(content)] };
}
function bulletList(items: string[]): AdfBulletList {
  return {
    type: 'bulletList',
    content: items.map(item => ({
      type: 'listItem' as const,
      content: [para(item)] as [AdfParagraph],
    })),
  };
}
function codeBlock(code: string, language = 'sh'): AdfCodeBlock {
  return { type: 'codeBlock', attrs: { language }, content: [adfText(code)] };
}

function buildAdf(cluster: BugCluster, replayCmd: string | undefined): AdfDocument {
  const nodes: AdfNode[] = [
    heading(3, 'Summary'),
    para(cluster.rootCause),
    heading(3, 'Suspected Files'),
    bulletList(cluster.suspectedFiles.length > 0 ? cluster.suspectedFiles : ['(none)']),
  ];

  if (replayCmd !== undefined) {
    nodes.push(heading(3, 'Replay Command'));
    nodes.push(codeBlock(replayCmd));
  }

  nodes.push(heading(3, 'Fix Hints'));
  nodes.push(bulletList(cluster.fixHints.length > 0 ? cluster.fixHints : ['(none)']));

  nodes.push(heading(3, 'Cluster Metadata'));
  nodes.push(bulletList([
    `ID: ${cluster.id}`,
    `Kind: ${cluster.kind}`,
    `Size: ${cluster.clusterSize}`,
    `First seen: ${cluster.firstSeenAt}`,
    `Last seen: ${cluster.lastSeenAt}`,
  ]));

  return { version: 1, type: 'doc', content: nodes };
}

export type JiraIssueDraft = {
  fields: {
    summary: string;
    description: AdfDocument;
    issuetype: { name: 'Bug' };
    priority: { name: 'Highest' | 'High' | 'Medium' | 'Low' };
    labels: string[];
  };
  bughunter: {
    runId: string;
    clusterId: string;
    kind: BugKind;
    severity: Severity;
    cwe: string[];
  };
};

export function renderJira(clusters: BugCluster[], extraLabels: string[] = []): JiraIssueDraft[] {
  const registry: RegistryLookup = DETECTOR_REGISTRY_MAP;
  return clusters.map(cluster => {
    const severity = severityForCluster(cluster);
    const meta = registry[cluster.kind];
    const replayCmd = cluster.occurrences[0]?.fullArtifacts ? cluster.occurrences[0].replayCommand : undefined;
    const rootCauseSnippet = cluster.rootCause.slice(0, 80);
    const summary = `[BugHunter ${severity}] ${cluster.kind}: ${rootCauseSnippet}`;

    const adf = buildAdf(cluster, replayCmd);
    const adfStr = JSON.stringify(adf);
    const descriptionDoc: AdfDocument = adfStr.length > DESC_MAX
      ? { version: 1, type: 'doc', content: [para(`${cluster.rootCause.slice(0, DESC_MAX)}${TRUNCATE_SUFFIX}`)] }
      : adf;

    const labels = [
      'bughunter',
      `severity-${severity}`,
      `kind-${cluster.kind}`,
      ...extraLabels,
    ];

    return {
      fields: {
        summary,
        description: descriptionDoc,
        issuetype: { name: 'Bug' },
        priority: { name: severityToJiraPriority(severity) },
        labels,
      },
      bughunter: {
        runId: cluster.runId,
        clusterId: cluster.id,
        kind: cluster.kind,
        severity,
        cwe: meta?.cwe ?? [],
      },
    };
  });
}
