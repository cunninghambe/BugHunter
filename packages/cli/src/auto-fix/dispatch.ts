// Auto-fix dispatch — two-phase per cluster: architect spec (Phase A) then
// coder implementation (Phase B) (§ 3.9.1–3.9.2).

import * as fs from 'node:fs';
import type { BugCluster, OccurrenceFull, BugsSkipped } from '../types.js';
import type { ClaudeMcpAdapter } from '../adapters/claude-mcp.js';
import { log } from '../log.js';

export type DispatchResult = {
  clusterId: string;
  architectJobId: string;
  coderJobId?: string;
  bugsSkipped?: BugsSkipped;
};

const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_ATTEMPTS = 180; // 30 min at 10s intervals

async function pollUntilDone(
  claudeMcp: ClaudeMcpAdapter,
  jobId: string,
): Promise<'done' | 'failed'> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const status = await claudeMcp.claude_job_status({ jobId });
    if (status.state === 'done') return 'done';
    if (status.state === 'failed' || status.state === 'cancelled' || status.state === 'interrupted') {
      return 'failed';
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return 'failed';
}

function firstNonBlankLine(text: string): string {
  return text.split('\n').find(l => l.trim().length > 0) ?? '';
}

export async function dispatchClusterFix(
  cluster: BugCluster,
  projectName: string,
  runId: string,
  projectDir: string,
  claudeMcp: ClaudeMcpAdapter,
  baseBranch = 'main',
): Promise<DispatchResult> {
  const branch = `bughunter/${runId}/${cluster.id}`;
  const specPath = `${projectDir}/.bughunter/runs/${runId}/specs/${cluster.id}.md`;
  const exemplar = cluster.occurrences.find((o): o is OccurrenceFull => o.fullArtifacts);

  // Phase A — architect spec (Opus role signalled via prompt)
  const architectPrompt = buildArchitectPrompt(cluster, runId, projectDir, branch, baseBranch, specPath, exemplar);
  const architectResult = await claudeMcp.claude_run({
    project: projectName,
    prompt: architectPrompt,
    allowedTools: [
      'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit',
      'ToolSearch', 'WebFetch', 'WebSearch', 'TodoWrite',
      'mcp__paperclip__*',
    ],
    timeoutMs: 1_800_000,
  });

  log.info(`Phase A dispatched for cluster ${cluster.id}`, { jobId: architectResult.jobId, branch });

  const phaseAOutcome = await pollUntilDone(claudeMcp, architectResult.jobId);
  if (phaseAOutcome === 'failed') {
    log.warn(`Phase A failed or timed out for cluster ${cluster.id}`);
    return {
      clusterId: cluster.id,
      architectJobId: architectResult.jobId,
      bugsSkipped: { reason: 'architect_refused', detail: 'Phase A job failed or timed out' },
    };
  }

  // Check for REFUSE in spec
  let specContent = '';
  try {
    specContent = fs.readFileSync(specPath, 'utf-8');
  } catch {
    log.warn(`Spec file not found for cluster ${cluster.id}: ${specPath}`);
  }

  const firstLine = firstNonBlankLine(specContent);
  if (firstLine.startsWith('REFUSE:')) {
    const reason = firstLine.slice('REFUSE:'.length).trim();
    log.info(`Architect refused cluster ${cluster.id}: ${reason}`);
    return {
      clusterId: cluster.id,
      architectJobId: architectResult.jobId,
      bugsSkipped: { reason: 'architect_refused', detail: reason },
    };
  }

  // Phase B — coder implementation (Sonnet role signalled via prompt)
  const coderPrompt = buildCoderPrompt(cluster, runId, branch, specPath);
  const coderResult = await claudeMcp.claude_run({
    project: projectName,
    prompt: coderPrompt,
    allowedTools: [
      'Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob',
      'ToolSearch', 'WebFetch', 'WebSearch', 'TodoWrite',
      'mcp__paperclip__*',
    ],
    timeoutMs: 3_600_000,
  });

  log.info(`Phase B dispatched for cluster ${cluster.id}`, { jobId: coderResult.jobId, branch });

  return {
    clusterId: cluster.id,
    architectJobId: architectResult.jobId,
    coderJobId: coderResult.jobId,
  };
}

function buildArchitectPrompt(
  cluster: BugCluster,
  runId: string,
  projectDir: string,
  branch: string,
  baseBranch: string,
  specPath: string,
  exemplar: OccurrenceFull | undefined,
): string {
  return [
    'You are an architect writing a focused fix spec for a single BugHunter cluster.',
    'You DO NOT implement the fix — you produce a spec the implementer will follow.',
    '',
    'Cluster:',
    `${projectDir}/.bughunter/runs/${runId}/bugs.jsonl   (cluster id: ${cluster.id})`,
    '',
    `Suspected files: ${JSON.stringify(cluster.suspectedFiles)}`,
    `Fix hints: ${JSON.stringify(cluster.fixHints)}`,
    `Sample occurrence with full repro context: ${JSON.stringify(exemplar ?? null)}`,
    '',
    'Investigate the root cause. Use gitnexus_impact if the project has gitnexus',
    'registered. Read the suspected files. Form a hypothesis.',
    '',
    `Write the spec to: ${specPath}`,
    '',
    "Format (follow the project's CLAUDE.md spec discipline):",
    "- Problem (one paragraph: what's broken and why)",
    '- Root cause (cite file:line)',
    "- Boundaries (what's in scope / what's not)",
    '- Interface change (if any types or signatures need to change)',
    '- Edge cases the fix must handle',
    '- Acceptance criteria (specific, testable)',
    '- Files to touch (exhaustive)',
    '',
    'If the fix is impossible (e.g. requires schema migration / forbidden-path',
    'changes), write a spec that says "REFUSE: <reason>" instead. The',
    'implementer will see this and refuse to proceed.',
    '',
    `Commit on branch ${branch} (create off ${baseBranch}).`,
    'Do NOT implement. Do NOT push.',
  ].join('\n');
}

function buildCoderPrompt(
  cluster: BugCluster,
  runId: string,
  branch: string,
  specPath: string,
): string {
  return [
    'You are a coder. Implement the fix described at:',
    `  ${specPath}`,
    '',
    `Working on branch ${branch} which already has the`,
    'spec committed by the architect. Read the spec; do not re-derive its',
    'decisions; do not exceed its boundaries. Treat the spec as the contract.',
    '',
    'Steps:',
    '  1. Implement the change exactly as specified.',
    `  2. Add a regression test that exercises one of the cluster's occurrences (cluster id: ${cluster.id}).`,
    "  3. Run the project's test command (npm test / pytest / etc.). Tests must",
    '     pass before commit.',
    `  4. Commit on the same branch with a message referencing the cluster id.`,
    '  5. Output last commit SHA.',
    'Do NOT push.',
    'Do NOT touch (will be hard-reset by the post-hoc gate):',
    '  prisma/migrations/**, prisma/schema.prisma, package.json, package-lock.json,',
    '  yarn.lock, pnpm-lock.yaml, .env*, .gitignore, migrations/**, alembic/**,',
    '  .next/**, node_modules/**, dist/**, build/**',
  ].join('\n');
}
