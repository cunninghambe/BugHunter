// Phase 7: auto-fix — per-cluster dispatch + forbidden-path gate + retest (§ 3.9).

import type { BugCluster, BugsSkipped } from '../types.js';
import type { ClaudeMcpAdapter } from '../adapters/claude-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { dispatchClusterFix } from '../auto-fix/dispatch.js';
import { checkForbiddenPaths, hardResetBranch } from '../auto-fix/forbidden-paths.js';
import { verifyClusterFix } from '../auto-fix/verify.js';
import { effectiveForbiddenPaths } from '../config.js';
import type { BugHunterConfig } from '../types.js';
import { log } from '../log.js';

export type AutoFixReport = {
  bugs_specced: number;
  bugs_attempted_fix: number;
  bugs_architect_refused: number;
  bugs_verified_fixed: number;
  partially_verified: number;
  bugs_persistent: number;
  bugs_skipped: number;
  bugs_lost_to_revision: number;
  clusterResults: Array<{
    clusterId: string;
    verdict?: string;
    bugsSkipped?: BugsSkipped;
    architectJobId?: string;
    coderJobId?: string;
    branch?: string;
  }>;
};

export async function runAutoFix(
  clusters: BugCluster[],
  projectDir: string,
  runId: string,
  config: BugHunterConfig,
  baseBranch: string,
  claudeMcp: ClaudeMcpAdapter,
  surface: SurfaceMcpAdapter,
  browser?: BrowserMcpAdapter
): Promise<AutoFixReport> {
  const forbiddenPatterns = effectiveForbiddenPaths(config);
  const projectName = config.autoFixDispatchProject ?? config.projectName;

  const report: AutoFixReport = {
    bugs_specced: 0,
    bugs_attempted_fix: 0,
    bugs_architect_refused: 0,
    bugs_verified_fixed: 0,
    partially_verified: 0,
    bugs_persistent: 0,
    bugs_skipped: 0,
    bugs_lost_to_revision: 0,
    clusterResults: [],
  };

  // Skip third-party clusters
  const actionable = clusters.filter(c => !c.thirdPartyOrGenerated);
  const thirdPartyCount = clusters.length - actionable.length;
  report.bugs_skipped += thirdPartyCount;

  for (const cluster of actionable) {
    const branch = `bughunter/${runId}/${cluster.id}`;
    log.info(`Auto-fix: dispatching cluster ${cluster.id}`);

    let dispatch: Awaited<ReturnType<typeof dispatchClusterFix>>;
    try {
      dispatch = await dispatchClusterFix(cluster, projectName, runId, projectDir, claudeMcp, baseBranch);
    } catch (err) {
      log.error(`Failed to dispatch fix for cluster ${cluster.id}`, err);
      const skipped: BugsSkipped = { reason: 'claude_refused' };
      report.bugs_skipped++;
      report.clusterResults.push({ clusterId: cluster.id, bugsSkipped: skipped });
      continue;
    }

    report.bugs_specced++;

    // Architect refused — no coder phase, no retest
    if (dispatch.bugsSkipped) {
      report.bugs_architect_refused++;
      report.bugs_skipped++;
      report.clusterResults.push({
        clusterId: cluster.id,
        bugsSkipped: dispatch.bugsSkipped,
        architectJobId: dispatch.architectJobId,
      });
      continue;
    }

    report.bugs_attempted_fix++;

    // Phase C: post-hoc forbidden-path gate (Phase B already committed)
    const gateResult = checkForbiddenPaths(projectDir, baseBranch, branch, forbiddenPatterns);

    if (!gateResult.allowed) {
      log.warn(`Forbidden paths touched for cluster ${cluster.id}`, gateResult.violatingPaths);
      hardResetBranch(projectDir, baseBranch, branch);
      const skipped: BugsSkipped = {
        reason: 'touched_forbidden_path',
        paths: gateResult.violatingPaths,
      };
      report.bugs_skipped++;
      report.clusterResults.push({
        clusterId: cluster.id,
        bugsSkipped: skipped,
        architectJobId: dispatch.architectJobId,
        coderJobId: dispatch.coderJobId,
        branch,
      });
      continue;
    }

    // Phase D: retest
    const verifyResult = await verifyClusterFix(cluster, projectDir, runId, surface, browser);

    switch (verifyResult.verdict) {
      case 'verified_fixed':
      case 'verified_fixed_by_removal':
        report.bugs_verified_fixed++;
        break;
      case 'partially_verified':
        report.partially_verified++;
        break;
      case 'not_fixed':
        report.bugs_persistent++;
        break;
    }

    report.clusterResults.push({
      clusterId: cluster.id,
      verdict: verifyResult.verdict,
      architectJobId: dispatch.architectJobId,
      coderJobId: dispatch.coderJobId,
      branch,
    });
  }

  return report;
}

