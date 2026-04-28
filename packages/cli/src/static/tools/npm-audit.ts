// npm audit static-analysis adapter (v0.5 T08).

import type { BugDetection } from '../../types.js';
import { NpmAuditOutputSchema } from '../schemas/npm-audit-schema.js';
import type { StaticTool } from '../runner.js';

const HIGH_SEVERITIES = new Set(['high', 'critical']);

export const npmAuditTool: StaticTool = {
  id: 'npm-audit',
  binary: 'npm',
  args: (_projectDir) => ['audit', '--json', '--audit-level=high'],
  timeoutMs: 60_000,
  optional: false,
  parseStdout,
};

function parseStdout(raw: string): { detections: BugDetection[]; warnings: string[] } {
  const parsed = NpmAuditOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { detections: [], warnings: [`npm-audit schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = [];

  // npm audit v7+ uses `vulnerabilities`
  if (parsed.data.vulnerabilities !== undefined) {
    for (const [pkgName, vuln] of Object.entries(parsed.data.vulnerabilities)) {
      if (!HIGH_SEVERITIES.has(vuln.severity.toLowerCase())) continue;
      detections.push({
        kind: 'vulnerable_dependency_high',
        rootCause: `${pkgName}: ${vuln.severity} vulnerability`,
        staticContext: {
          tool: 'npm-audit',
          ruleId: pkgName,
          sourceFile: 'package-lock.json',
        },
      });
    }
    return { detections, warnings: [] };
  }

  // npm audit v6 uses `advisories`
  if (parsed.data.advisories !== undefined) {
    for (const [advisoryId, advisory] of Object.entries(parsed.data.advisories)) {
      if (!HIGH_SEVERITIES.has(advisory.severity.toLowerCase())) continue;
      const pkgName = advisory.module_name ?? advisory.name ?? 'unknown';
      detections.push({
        kind: 'vulnerable_dependency_high',
        rootCause: `${pkgName}: ${advisory.title} (${advisory.severity})`,
        staticContext: {
          tool: 'npm-audit',
          ruleId: advisoryId,
          sourceFile: 'package-lock.json',
        },
      });
    }
  }

  return { detections, warnings: [] };
}
