// v0.29: --fail-on parsing + evaluation for bughunter ci.

import type { BugCluster, BugKind, Severity } from '../types.js';
import { severityForCluster, severityAtLeast } from './severity.js';

export type FailOnRule =
  | { kind: 'severity'; min: Severity }
  | { kind: 'count'; threshold: number }
  | { kind: 'regression'; min: Severity }
  | { kind: 'bugKind'; bugKind: BugKind }
  | { kind: 'never' };

type SeverityAliasMap = Record<string, Severity | undefined>;
const SEVERITY_ALIASES: SeverityAliasMap = {
  critical: 'critical',
  'major+': 'major',
  major: 'major',
  'high+': 'major',
  high: 'major',
  'minor+': 'minor',
  minor: 'minor',
  'info+': 'info',
  any: 'info',
};

export function parseFailOn(spec: string | undefined): FailOnRule {
  if (spec === undefined || spec === '' || spec.toLowerCase() === 'never') {
    return { kind: 'never' };
  }
  const lower = spec.toLowerCase();

  const aliasSev = SEVERITY_ALIASES[lower];
  if (aliasSev !== undefined) {
    return { kind: 'severity', min: aliasSev };
  }

  if (lower.startsWith('count:')) {
    const n = parseInt(lower.slice(6), 10);
    if (isNaN(n) || n < 0) {
      return invalidFailOn(spec);
    }
    return { kind: 'count', threshold: n };
  }

  if (lower.startsWith('regression:')) {
    const sev = lower.slice(11) as Severity;
    if (!['critical', 'major', 'minor', 'info'].includes(sev)) {
      return invalidFailOn(spec);
    }
    return { kind: 'regression', min: sev };
  }

  if (lower.startsWith('kind:')) {
    const bugKind = spec.slice(5) as BugKind;
    return { kind: 'bugKind', bugKind };
  }

  return invalidFailOn(spec);
}

function invalidFailOn(spec: string): never {
  process.stderr.write(`Invalid --fail-on: ${spec}\n`);
  process.exit(2);
}

export type DiffSummary = {
  added: BugCluster[];
  regressed: BugCluster[];
};

export function evaluateFailOn(
  rule: FailOnRule,
  clusters: BugCluster[],
  diff: DiffSummary | null,
): boolean {
  switch (rule.kind) {
    case 'never':
      return false;
    case 'severity':
      return clusters.some(c => severityAtLeast(severityForCluster(c), rule.min));
    case 'count':
      return clusters.length >= rule.threshold;
    case 'regression': {
      if (diff === null) {
        process.stderr.write('--fail-on regression requires --diff-against\n');
        process.exit(2);
      }
      const candidates = [...diff.added, ...diff.regressed];
      return candidates.some(c => severityAtLeast(severityForCluster(c), rule.min));
    }
    case 'bugKind':
      return clusters.some(c => c.kind === rule.bugKind);
  }
}

export function describeFailOn(rule: FailOnRule): string {
  switch (rule.kind) {
    case 'never': return 'none (always pass)';
    case 'severity': return `any cluster with severity >= ${rule.min}`;
    case 'count': return `total clusters >= ${rule.threshold}`;
    case 'regression': return `new or regressed clusters with severity >= ${rule.min}`;
    case 'bugKind': return `any cluster of kind '${rule.bugKind}'`;
  }
}
