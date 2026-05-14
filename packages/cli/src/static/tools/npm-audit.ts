// npm audit static-analysis adapter (v0.5 T08).
//
// v0.51: collapse transitive vulnerabilities into their direct parents
// (BENCHMARK_SPOONWORKS.md bonus #4). npm audit reports both direct and
// transitive packages as separate "vulnerabilities" entries; emitting each
// produces noise like "fast-uri: high" alongside "@sentry/nextjs: high"
// when the only actionable advice for both is "upgrade @sentry/nextjs".

import type { BugDetection } from '../../types.js';
import { NpmAuditOutputSchema } from '../schemas/npm-audit-schema.js';
import type { NpmAuditOutput, NpmAuditVulnerability } from '../schemas/npm-audit-schema.js';
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

/**
 * Walk the `via` graph upward to find the direct parent for a transitive
 * vulnerability. Returns null when the transitive can't be traced to any
 * direct vuln (rare, but possible when npm audit's graph is partial).
 */
function findDirectParent(
  vulnName: string,
  vulnerabilities: Record<string, NpmAuditVulnerability>,
  visited = new Set<string>(),
): string | null {
  if (visited.has(vulnName)) return null;
  visited.add(vulnName);

  // Find any vuln whose `via` references vulnName. npm audit's `via` array
  // can contain either bare strings (package names) or advisory objects.
  for (const [parentName, parent] of Object.entries(vulnerabilities)) {
    const viaNames = parent.via.map(v =>
      typeof v === 'string' ? v : (typeof v === 'object' && v !== null && 'name' in v ? String((v as { name?: unknown }).name ?? '') : ''),
    ).filter(s => s !== '');
    if (!viaNames.includes(vulnName)) continue;
    if (parent.isDirect === true) return parentName;
    // Recurse: walk up further.
    const ancestor = findDirectParent(parentName, vulnerabilities, visited);
    if (ancestor !== null) return ancestor;
  }
  return null;
}

function parseStdout(raw: string): { detections: BugDetection[]; warnings: string[] } {
  let parsed: { success: true; data: NpmAuditOutput } | { success: false; error: { message: string } };
  try {
    parsed = NpmAuditOutputSchema.safeParse(JSON.parse(raw));
  } catch (err) {
    return { detections: [], warnings: [`npm-audit JSON parse error: ${String(err)}`] };
  }
  if (!parsed.success) {
    return { detections: [], warnings: [`npm-audit schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = [];

  // npm audit v7+ uses `vulnerabilities`
  if (parsed.data.vulnerabilities !== undefined) {
    const vulnerabilities = parsed.data.vulnerabilities;
    const highSevEntries = Object.entries(vulnerabilities).filter(
      ([, v]) => HIGH_SEVERITIES.has(v.severity.toLowerCase()),
    );

    // Group transitive vulns by their direct parent name. Transitive vulns
    // with no traceable parent are emitted standalone (preserves the prior
    // behavior for partial-graph cases).
    const transitiveByParent = new Map<string, string[]>();
    const orphanTransitive: string[] = [];
    for (const [name, vuln] of highSevEntries) {
      if (vuln.isDirect === true) continue;
      const parent = findDirectParent(name, vulnerabilities);
      if (parent !== null) {
        const arr = transitiveByParent.get(parent) ?? [];
        arr.push(name);
        transitiveByParent.set(parent, arr);
      } else {
        orphanTransitive.push(name);
      }
    }

    // Emit direct vulns, enriched with transitive children they pull in.
    for (const [pkgName, vuln] of highSevEntries) {
      if (vuln.isDirect !== true) continue;
      const transitives = transitiveByParent.get(pkgName) ?? [];
      const transitiveSuffix = transitives.length > 0
        ? ` (pulls in vulnerable: ${transitives.sort().join(', ')})`
        : '';
      detections.push({
        kind: 'vulnerable_dependency_high',
        rootCause: `${pkgName}: ${vuln.severity} vulnerability${transitiveSuffix}`,
        staticContext: {
          tool: 'npm-audit',
          ruleId: pkgName,
          sourceFile: 'package-lock.json',
        },
      });
    }

    // Emit orphan transitive vulns (no traceable direct parent) standalone.
    // This shouldn't happen on well-formed npm audit output but keeps us safe
    // when the graph is partial.
    for (const pkgName of orphanTransitive) {
      const vuln = vulnerabilities[pkgName];
      if (vuln === undefined) continue;
      detections.push({
        kind: 'vulnerable_dependency_high',
        rootCause: `${pkgName}: ${vuln.severity} vulnerability (transitive; no direct parent in audit graph)`,
        staticContext: {
          tool: 'npm-audit',
          ruleId: pkgName,
          sourceFile: 'package-lock.json',
        },
      });
    }

    return { detections, warnings: [] };
  }

  // npm audit v6 uses `advisories` — older format does not have isDirect, so
  // emit every advisory as before. Collapse logic does not apply.
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
