// SARIF 2.1.0 placeholder output for `bughunter diff --format sarif`.
// TODO(V29): full taxonomy mapping — CWE IDs, severity → SARIF level, rule metadata.

import type { ClusterRow } from '../store/history.js';

type SarifResult = {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  properties: { bugIdentity: string; bucket: 'new' | 'regressed' };
};

type SarifOutput = {
  version: '2.1.0';
  $schema: string;
  runs: Array<{
    tool: { driver: { name: string; rules: unknown[] } };
    results: SarifResult[];
  }>;
};

export function formatSarif(
  newClusters: ClusterRow[],
  regressedClusters: ClusterRow[],
): string {
  const toResult = (c: ClusterRow, bucket: 'new' | 'regressed'): SarifResult => ({
    ruleId: c.kind,
    // TODO(V29): map BugKind severity to 'error'|'warning'|'note'
    level: 'warning',
    message: { text: c.root_cause.slice(0, 500) },
    properties: { bugIdentity: c.bug_identity, bucket },
  });

  const results: SarifResult[] = [
    ...newClusters.map(c => toResult(c, 'new')),
    ...regressedClusters.map(c => toResult(c, 'regressed')),
  ];

  const sarif: SarifOutput = {
    version: '2.1.0',
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [{ tool: { driver: { name: 'BugHunter', rules: [] } }, results }],
  };
  return JSON.stringify(sarif, null, 2);
}
