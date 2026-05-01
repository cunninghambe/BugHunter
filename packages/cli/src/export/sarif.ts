// v0.29: SARIF 2.1.0 emitter.
// Schema refs: OASIS sarif-v2.1.0-os.html §3.13 run, §3.14 tool, §3.18 toolComponent,
// §3.20 invocation, §3.27 result, §3.28 location, §3.49 reportingDescriptor.

import type { BugCluster, BugKind } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { DetectorMetadata } from '../detectors/registry.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';
import { severityForCluster, severityToSarifLevel, severityToSarifSecurity } from './severity.js';

const BUGHUNTER_VERSION = '0.1.0';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFO_URI = 'https://github.com/cunninghambe/BugHunter';

export type SarifRunState = {
  runId: string;
  startedAt: string;
  projectDir: string;
};

export type SarifLog = {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
};

type SarifRun = {
  tool: { driver: ToolDriver };
  invocations: Invocation[];
  results: SarifResult[];
  automationDetails: { id: string };
  originalUriBaseIds: Record<string, { uri: string }>;
};

type ToolDriver = {
  name: string;
  version: string;
  informationUri: string;
  rules: ReportingDescriptor[];
};

type ReportingDescriptor = {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: string };
  helpUri?: string;
  properties: Record<string, unknown>;
};

type Invocation = {
  executionSuccessful: boolean;
  startTimeUtc: string;
  endTimeUtc: string;
  workingDirectory: { uri: string };
};

type SarifResult = {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
  partialFingerprints: Record<string, string>;
  properties: Record<string, unknown>;
};

type SarifLocation = {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
  };
};

function toSarifUri(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

// Use Record<string, ...> to avoid TS unnecessary-condition warnings on lookup of BugKind keys.
type RegistryLookup = Record<string, DetectorMetadata | undefined>;

function buildRule(kind: BugKind, registry: RegistryLookup): ReportingDescriptor {
  const meta = registry[kind];
  const severity = meta?.severity ?? 'info';
  const ruleProps: Record<string, unknown> = {
    'security-severity': severityToSarifSecurity(severity),
    'bughunter.severity': severity,
  };
  if (meta?.cwe !== undefined) {
    ruleProps['cwe'] = meta.cwe;
  }
  if (meta?.exploitabilityModel !== undefined) {
    ruleProps['bughunter.exploitabilityModel'] = meta.exploitabilityModel;
  }

  const rule: ReportingDescriptor = {
    id: kind,
    name: meta?.displayName ?? kind,
    shortDescription: { text: kind },
    fullDescription: { text: meta?.description ?? kind },
    defaultConfiguration: { level: severityToSarifLevel(severity) },
    properties: ruleProps,
  };
  if (meta?.helpUri !== undefined) {
    rule.helpUri = meta.helpUri;
  }
  return rule;
}

export function renderSarif(clusters: BugCluster[], state: SarifRunState): SarifLog {
  const usedKinds = [...new Set(clusters.map(c => c.kind))];
  const kindIndex = new Map<BugKind, number>(usedKinds.map((k, i) => [k, i]));
  const registry: RegistryLookup = DETECTOR_REGISTRY_MAP;

  const rules: ReportingDescriptor[] = usedKinds.map(kind => buildRule(kind, registry));

  const results: SarifResult[] = clusters.map(cluster => {
    const severity = severityForCluster(cluster);
    const firstFile = cluster.suspectedFiles[0];
    const fileUri = firstFile !== undefined
      ? toSarifUri(suspectedFilePath(firstFile))
      : 'unknown';
    const replayCmd = cluster.occurrences[0]?.fullArtifacts ? cluster.occurrences[0].replayCommand : undefined;

    const props: Record<string, unknown> = {
      'bughunter.clusterId': cluster.id,
      'bughunter.runId': cluster.runId,
      'bughunter.clusterSize': cluster.clusterSize,
      'bughunter.firstSeenAt': cluster.firstSeenAt,
      'bughunter.lastSeenAt': cluster.lastSeenAt,
    };
    if (cluster.verdict !== undefined) props['bughunter.verdict'] = cluster.verdict;
    if (replayCmd !== undefined) props['bughunter.replayCommand'] = replayCmd;

    return {
      ruleId: cluster.kind,
      ruleIndex: kindIndex.get(cluster.kind) ?? 0,
      level: severityToSarifLevel(severity),
      message: { text: cluster.rootCause },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: fileUri, uriBaseId: 'SRCROOT' },
          },
        },
      ],
      partialFingerprints: {
        'bughunter.clusterSignature/v1': cluster.signatureKey ?? cluster.id,
      },
      properties: props,
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'BugHunter',
            version: BUGHUNTER_VERSION,
            informationUri: INFO_URI,
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: state.startedAt,
            endTimeUtc: new Date().toISOString(),
            workingDirectory: { uri: `file://${state.projectDir}` },
          },
        ],
        results,
        automationDetails: { id: `bughunter/${state.runId}` },
        originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
      },
    ],
  };
}
