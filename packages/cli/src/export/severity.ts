// v0.29: severity helpers — single source of truth for all emitters.

import type { BugCluster, Severity } from '../types.js';
import { DETECTOR_REGISTRY_MAP } from '../detectors/registry.js';

export type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export function severityForCluster(cluster: Pick<BugCluster, 'kind' | 'severity'>): Severity {
  if (cluster.severity !== undefined) return cluster.severity;
  const entry = DETECTOR_REGISTRY_MAP[cluster.kind];
  if (entry === undefined) {
    process.stderr.write(`[bughunter] warn: unknown kind '${cluster.kind}' not in DETECTOR_REGISTRY; defaulting to info\n`);
    return 'info';
  }
  return entry.severity;
}

/** SARIF §3.27.10 result.level: critical/major → error, minor → warning, info → note. */
export function severityToSarifLevel(severity: Severity): SarifLevel {
  switch (severity) {
    case 'critical': return 'error';
    case 'major': return 'error';
    case 'minor': return 'warning';
    case 'info': return 'note';
  }
}

/** GitHub code-scanning uses this numeric string for scoring (SARIF §3.49.13 properties). */
export function severityToSarifSecurity(severity: Severity): string {
  switch (severity) {
    case 'critical': return '9.5';
    case 'major': return '7.5';
    case 'minor': return '4.0';
    case 'info': return '1.0';
  }
}

/** GitLab Security Report 15.0.0 severity labels. */
export function severityToGitlabSeverity(severity: Severity): 'Critical' | 'High' | 'Medium' | 'Info' {
  switch (severity) {
    case 'critical': return 'Critical';
    case 'major': return 'High';
    case 'minor': return 'Medium';
    case 'info': return 'Info';
  }
}

/** Linear priority: 1=urgent, 2=high, 3=medium, 4=low. */
export function severityToLinearPriority(severity: Severity): 1 | 2 | 3 | 4 {
  switch (severity) {
    case 'critical': return 1;
    case 'major': return 2;
    case 'minor': return 3;
    case 'info': return 4;
  }
}

/** Jira priority names. */
export function severityToJiraPriority(severity: Severity): 'Highest' | 'High' | 'Medium' | 'Low' {
  switch (severity) {
    case 'critical': return 'Highest';
    case 'major': return 'High';
    case 'minor': return 'Medium';
    case 'info': return 'Low';
  }
}

const SEVERITY_ORDER: Severity[] = ['critical', 'major', 'minor', 'info'];

/** Returns true if a >= b in severity (critical > major > minor > info). */
export function severityAtLeast(a: Severity, b: Severity): boolean {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b);
}
