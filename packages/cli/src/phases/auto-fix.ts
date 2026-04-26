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
  bugs_attempted_fix: number;
  bugs_verified_fixed: number;
  partially_verified: number;
  bugs_persistent: number;
  bugs_skipped: number;
  bugs_lost_to_revision: number;
  clusterResults: Array<{
    clusterId: string;
    verdict?: string;
    bugsSkipped?: BugsSkipped;
    jobId?: string;
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
    bugs_attempted_fix: 0,
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

    let jobId: string;
    try {
      const dispatch = await dispatchClusterFix(cluster, projectName, runId, projectDir, claudeMcp);
      jobId = dispatch.jobId;
      report.bugs_attempted_fix++;
    } catch (err) {
      log.error(`Failed to dispatch fix for cluster ${cluster.id}`, err);
      const skipped: BugsSkipped = { reason: 'claude_refused' };
      report.bugs_skipped++;
      report.clusterResults.push({ clusterId: cluster.id, bugsSkipped: skipped });
      continue;
    }

    // Wait for job to complete (poll)
    const jobResult = await pollJobCompletion(jobId, claudeMcp);

    if (!jobResult) {
      const skipped: BugsSkipped = { reason: 'claude_refused' };
      report.bugs_skipped++;
      report.clusterResults.push({ clusterId: cluster.id, bugsSkipped: skipped, jobId });
      continue;
    }

    // Post-hoc forbidden-path gate
    const gateResult = checkForbiddenPaths(projectDir, baseBranch, branch, forbiddenPatterns);

    if (!gateResult.allowed) {
      log.warn(`Forbidden paths touched for cluster ${cluster.id}`, gateResult.violatingPaths);
      hardResetBranch(projectDir, baseBranch, branch);
      const skipped: BugsSkipped = {
        reason: 'touched_forbidden_path',
        paths: gateResult.violatingPaths,
      };
      report.bugs_skipped++;
      report.clusterResults.push({ clusterId: cluster.id, bugsSkipped: skipped, jobId, branch });
      continue;
    }

    // Retest
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
      jobId,
      branch,
    });
  }

  return report;
}

async function pollJobCompletion(
  jobId: string,
  claudeMcp: ClaudeMcpAdapter
): Promise<{ commitSha?: string } | null> {
  const maxWaitMs = 3_600_000; // 1h
  const pollIntervalMs = 10_000; // 10s
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const status = await claudeMcp.claude_job_status({ jobId }).catch(() => null);
    if (!status) continue;
    if (status.state === 'done') return { commitSha: status.commitSha };
    if (status.state === 'failed' || status.state === 'cancelled') return null;
  }
  return null;
}
