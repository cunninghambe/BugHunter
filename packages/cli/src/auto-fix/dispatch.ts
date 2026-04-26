// Auto-fix dispatch — one ClaudeMCP claude_run per cluster (§ 3.9).

import type { BugCluster } from '../types.js';
import type { ClaudeMcpAdapter } from '../adapters/claude-mcp.js';
import { log } from '../log.js';

export type DispatchResult = {
  clusterId: string;
  jobId: string;
};

export async function dispatchClusterFix(
  cluster: BugCluster,
  projectName: string,
  runId: string,
  projectDir: string,
  claudeMcp: ClaudeMcpAdapter
): Promise<DispatchResult> {
  const branch = `bughunter/${runId}/${cluster.id}`;

  const prompt = buildFixPrompt(cluster, runId, projectDir, branch);

  const result = await claudeMcp.claude_run({
    project: projectName,
    prompt,
    allowedTools: [
      'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob',
      'ToolSearch', 'WebFetch', 'WebSearch', 'TodoWrite',
      'mcp__paperclip__*',
    ],
    timeoutMs: 3_600_000, // 1h per cluster
  });

  log.info(`Dispatched fix for cluster ${cluster.id}`, { jobId: result.jobId, branch });
  return { clusterId: cluster.id, jobId: result.jobId };
}

function buildFixPrompt(
  cluster: BugCluster,
  runId: string,
  projectDir: string,
  branch: string
): string {
  return [
    'Fix one bug cluster from a BugHunter run.',
    `Run: ${projectDir}/.bughunter/runs/${runId}/bugs.jsonl`,
    `Cluster id: ${cluster.id}`,
    `suspectedFiles: ${JSON.stringify(cluster.suspectedFiles)}`,
    `fixHints: ${JSON.stringify(cluster.fixHints)}`,
    'Steps:',
    '  1. Investigate root cause (use gitnexus_impact if available)',
    '  2. Write the fix',
    '  3. Add regression test exercising one of the cluster\'s occurrences',
    `  4. Commit on branch ${branch}`,
    '  5. Output last commit SHA',
    'Do NOT push. Do NOT touch: prisma/migrations/**, prisma/schema.prisma,',
    '  package.json, package-lock.json, .env*, .gitignore, migrations/**, alembic/**',
  ].join('\n');
}
