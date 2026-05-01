// v0.29: GitLab Security Report 15.0.0 emitter.

import type { BugCluster } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { DetectorMetadata } from '../detectors/registry.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';
import { severityForCluster, severityToGitlabSeverity } from './severity.js';

const BUGHUNTER_VERSION = '0.1.0';
type RegistryLookup = Record<string, DetectorMetadata | undefined>;

type GitlabScanner = { id: string; name: string; version: string; vendor: { name: string } };
type GitlabIdentifier = { type: string; name: string; value: string };
type GitlabVulnerability = {
  id: string;
  category: 'sast';
  name: string;
  message: string;
  description: string;
  cve: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Info';
  scanner: { id: string; name: string };
  location: { file: string; start_line: number };
  identifiers: GitlabIdentifier[];
};

type GitlabReport = {
  version: '15.0.0';
  scan: {
    scanner: GitlabScanner;
    type: 'sast';
    start_time: string;
    end_time: string;
    status: 'success';
  };
  vulnerabilities: GitlabVulnerability[];
};

export function renderGitlab(clusters: BugCluster[], startedAt: string): GitlabReport {
  const scanner: GitlabScanner = {
    id: 'bughunter',
    name: 'BugHunter',
    version: BUGHUNTER_VERSION,
    vendor: { name: 'BugHunter' },
  };

  const registry: RegistryLookup = DETECTOR_REGISTRY_MAP;

  const vulnerabilities: GitlabVulnerability[] = clusters.map(cluster => {
    const severity = severityForCluster(cluster);
    const meta = registry[cluster.kind];
    const cwe = meta?.cwe ?? [];

    const identifiers: GitlabIdentifier[] = [
      { type: 'bughunter_kind', name: cluster.kind, value: cluster.kind },
      ...cwe.map(c => ({ type: 'cwe', name: c, value: c })),
    ];

    return {
      id: cluster.id,
      category: 'sast' as const,
      name: meta !== undefined ? meta.displayName : cluster.kind,
      message: cluster.rootCause,
      description: cluster.fixHints.join('\n'),
      cve: `BugHunter-${cluster.kind}-${cluster.id}`,
      severity: severityToGitlabSeverity(severity),
      scanner: { id: 'bughunter', name: 'BugHunter' },
      location: {
        file: cluster.suspectedFiles[0] !== undefined ? suspectedFilePath(cluster.suspectedFiles[0]) : 'unknown',
        start_line: 1,
      },
      identifiers,
    };
  });

  return {
    version: '15.0.0',
    scan: {
      scanner,
      type: 'sast',
      start_time: startedAt,
      end_time: new Date().toISOString(),
      status: 'success',
    },
    vulnerabilities,
  };
}
