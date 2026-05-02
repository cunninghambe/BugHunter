// bughunt_fix_dispatch / _status / _gate / _retest — fix-loop coordination.
// Subprocess lifecycle: detached spawn, unref, SIGTERM→SIGKILL fuse, server-restart reconciliation.

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createId } from '@paralleldrive/cuid2';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, runPaths } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { forbiddenPathGate, validateGitRef } from 'bughunter/src/ops/forbidden-paths.js';
import { retestOp } from 'bughunter/src/ops/retest.js';
import { computeFixSummary } from 'bughunter/src/ops/fix-summary.js';
import type { BugCluster } from 'bughunter/src/types.js';

// ---------------------------------------------------------------------------
// Module-level state (outlives per-request McpServer instances)
// ---------------------------------------------------------------------------

export type FixJobState = 'running' | 'done' | 'failed' | 'killed';

type FixJobHandle = {
  jobId: string;
  runId: string;
  clusterId: string;
  pid: number;
  child: ChildProcess;
  startedAt: number;
  state: FixJobState;
  exitCode?: number;
  logPath: string;
  metaPath: string;
  killTimer: ReturnType<typeof setTimeout>;
};

// Exported for tests and server-restart reconciliation
export const fixJobs = new Map<string, FixJobHandle>();

const MAX_CONCURRENT_FIX_JOBS = 4;
const DEFAULT_MAX_RUNTIME_MS = 1_800_000; // 30m

// Allowlist for fix binary validation (§5)
const FIX_BINARY_ALLOWLIST = process.env['BUGHUNTER_FIX_BINARY_ALLOWLIST']?.split(':') ?? [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCluster(projectDir: string, runId: string, clusterId: string): BugCluster {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.bugsFile)) {
    throw new NotFoundError(`No bugs.jsonl found for run ${runId}`);
  }
  const lines = fs.readFileSync(paths.bugsFile, 'utf-8').split('\n').filter(Boolean);
  const cluster = lines.map(l => JSON.parse(l) as BugCluster).find(c => c.id === clusterId);
  if (cluster === undefined) {
    throw new NotFoundError(`Cluster ${clusterId} not found in run ${runId}`);
  }
  return cluster;
}

function persistMeta(handle: FixJobHandle): void {
  const meta = {
    jobId: handle.jobId,
    runId: handle.runId,
    clusterId: handle.clusterId,
    pid: handle.pid,
    startedAt: handle.startedAt,
    state: handle.state,
    exitCode: handle.exitCode,
    logPath: handle.logPath,
  };
  fs.writeFileSync(handle.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function killProcessTree(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* process may have already exited */ }
}

function scheduleKill(handle: FixJobHandle, maxRuntimeMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (handle.state !== 'running') return;
    killProcessTree(handle.pid);
    setTimeout(() => {
      if (handle.state !== 'running') return;
      try { process.kill(-handle.pid, 'SIGKILL'); } catch { /* ok */ }
      handle.state = 'killed';
      handle.exitCode = -1;
      fixJobs.delete(handle.jobId);
      persistMeta(handle);
    }, 5000);
  }, maxRuntimeMs);
}

function validateBinary(binary: string): boolean {
  // basename (no slash) is always allowed
  if (!binary.includes('/')) return true;
  // absolute path under allowlist entries
  return FIX_BINARY_ALLOWLIST.some(allowed => binary.startsWith(allowed));
}

function buildFilteredEnv(projectDir: string, agent: string, branch: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'BUGHUNTER_FIX_AGENT', 'BUGHUNTER_FIX_BRANCH'];
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const val = process.env[key];
    if (val !== undefined) filtered[key] = val;
  }
  filtered['BUGHUNTER_FIX_AGENT'] = agent;
  filtered['BUGHUNTER_FIX_BRANCH'] = branch;
  filtered['BUGHUNTER_PROJECT_DIR'] = projectDir;
  return filtered;
}

/** On server restart: reconcile running jobs in meta files with actual OS process state. */
export function reconcileFixJobs(projectDir: string): void {
  const runsDir = path.join(projectDir, '.bughunter', 'runs');
  if (!fs.existsSync(runsDir)) return;
  for (const runId of fs.readdirSync(runsDir)) {
    const fixJobsDir = path.join(runsDir, runId, 'fix-jobs');
    if (!fs.existsSync(fixJobsDir)) continue;
    for (const f of fs.readdirSync(fixJobsDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(fixJobsDir, f), 'utf-8')) as {
          jobId: string; runId: string; clusterId: string; pid: number;
          state: FixJobState; exitCode?: number; logPath: string; startedAt: number;
        };
        if (meta.state !== 'running') continue;
        // Check liveness
        let alive = false;
        try { process.kill(meta.pid, 0); alive = true; } catch { /* dead */ }
        if (!alive) {
          meta.state = 'killed';
          fs.writeFileSync(path.join(fixJobsDir, f), `${JSON.stringify(meta, null, 2)}\n`);
        }
        // Don't add to fixJobs Map — we lost the ChildProcess ref; status-only via meta file
      } catch { /* skip corrupt meta */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

// cuid2: lowercase letter + 23 lowercase-alphanumeric chars (BugHunter-minted only)
const CUID2 = z.string().regex(/^[a-z][a-z0-9]{23}$/, 'must be a cuid2 identifier');
// git ref: strict charset matching git's allowed characters
const GIT_REF = z.string().regex(/^[a-zA-Z0-9._/-]+$/, 'must be a valid git ref name');

const FixDispatchInput = z.object({
  project: z.string().min(1),
  runId: CUID2,
  clusterId: CUID2,
  agent: z.enum(['architect', 'coder']),
  model: z.string().min(1),
  prompt: z.string().min(1),
  binary: z.string().optional(),
  branch: GIT_REF.optional(),
  maxRuntimeMs: z.number().int().positive().max(3_600_000).optional(),
});

const FixStatusInput = z.object({
  project: z.string().min(1),
  runId: CUID2,
});

const FixGateInput = z.object({
  project: z.string().min(1),
  runId: CUID2,
  clusterId: CUID2,
  branch: GIT_REF,
  baseBranch: GIT_REF.optional(),
  reset: z.boolean().optional(),
});

const FixRetestInput = z.object({
  project: z.string().min(1),
  runId: CUID2,
  clusterId: CUID2,
  branch: GIT_REF.optional(),
  baseBranch: GIT_REF.optional(),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerFixCoordTools(server: McpServer): void {
  // bughunt_fix_dispatch
  server.tool(
    'bughunt_fix_dispatch',
    'Spawn a fix-attempt subprocess for one cluster. Returns a jobId immediately; poll bughunt_fix_status.',
    FixDispatchInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- returns immediately; subprocess is async
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        findCluster(projectDir, args.runId, args.clusterId);

        const runningCount = [...fixJobs.values()].filter(j => j.state === 'running').length;
        if (runningCount >= MAX_CONCURRENT_FIX_JOBS) {
          return toolErr('conflict', `too many running fix jobs (${MAX_CONCURRENT_FIX_JOBS}); poll bughunt_fix_status`);
        }

        const binary = args.binary ?? process.env['BUGHUNTER_FIX_BINARY'] ?? 'claude';
        if (!validateBinary(binary)) {
          return toolErr('forbidden', `binary '${binary}' not in allowlist; set BUGHUNTER_FIX_BINARY_ALLOWLIST`);
        }

        const branchName = args.branch ?? `fix/${args.runId}/${args.clusterId}`;
        validateGitRef(branchName);

        // Branch creation / reuse logic
        try {
          let headOutput: string;
          try {
            headOutput = execFileSync('git', ['rev-parse', branchName], {
              cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          } catch {
            headOutput = 'ABSENT';
          }

          if (headOutput !== 'ABSENT') {
            const baseOutput = execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: projectDir, encoding: 'utf-8',
            }).trim();
            if (headOutput !== baseOutput) {
              return toolErr('conflict', `branch '${branchName}' exists with diverged commits; use bughunt_fix_gate reset=true then retry`);
            }
            // Branch exists at same HEAD as base — reuse (EC-F2)
          } else {
            execFileSync('git', ['checkout', '-b', branchName], { cwd: projectDir, stdio: 'pipe' });
          }
        } catch (e) {
          return toolErr('error', `git error: ${String(e)}`);
        }

        const jobId = createId();
        const paths = runPaths(projectDir, args.runId);
        const fixJobsDir = path.join(paths.runDir, 'fix-jobs');
        fs.mkdirSync(fixJobsDir, { recursive: true });

        const logPath = path.join(fixJobsDir, `${jobId}.log`);
        const metaPath = path.join(fixJobsDir, `${jobId}.meta.json`);
        const maxRuntimeMs = args.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;

        const cliArgs = ['-p', '--input-format', 'text', '--output-format', 'json', '--model', args.model];
        const filteredEnv = buildFilteredEnv(projectDir, args.agent, branchName);

        let child: ChildProcess;
        const logFd = fs.openSync(logPath, 'a');
        try {
          child = spawn(binary, cliArgs, {
            cwd: projectDir,
            stdio: ['pipe', logFd, logFd],
            detached: true,
            env: filteredEnv,
          });
        } catch (e) {
          fs.closeSync(logFd);
          return toolErr('subprocess_failed', `spawn failed: ${String(e)}`);
        }
        fs.closeSync(logFd);

        if (child.stdin !== null) {
          child.stdin.write(args.prompt);
          child.stdin.end();
        }
        child.unref();

        const handle: FixJobHandle = {
          jobId,
          runId: args.runId,
          clusterId: args.clusterId,
          pid: child.pid ?? 0,
          child,
          startedAt: Date.now(),
          state: 'running',
          logPath,
          metaPath,
          killTimer: scheduleKill(
            // We forward-reference handle; populate killTimer after creation
            {} as FixJobHandle,
            maxRuntimeMs,
          ),
        };
        // Re-schedule kill with real handle reference
        clearTimeout(handle.killTimer);
        handle.killTimer = scheduleKill(handle, maxRuntimeMs);

        child.on('exit', (code) => {
          handle.state = code === 0 ? 'done' : 'failed';
          handle.exitCode = code ?? -1;
          clearTimeout(handle.killTimer);
          fixJobs.delete(jobId);
          persistMeta(handle);
        });
        child.on('error', () => {
          handle.state = 'failed';
          clearTimeout(handle.killTimer);
          fixJobs.delete(jobId);
          persistMeta(handle);
        });

        fixJobs.set(jobId, handle);

        // Persist initial meta
        persistMeta(handle);

        return toolOk({ ok: true, jobId, branchName, dispatched: 'shell' });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  // bughunt_fix_status
  server.tool(
    'bughunt_fix_status',
    'Per-cluster verdict snapshot for a run. Mirrors bughunter fix-summary but returns JSON.',
    FixStatusInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous file reads
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const paths = runPaths(projectDir, args.runId);
        if (!fs.existsSync(paths.runDir)) {
          return toolErr('not_found', `run ${args.runId} not found`);
        }

        const summary = computeFixSummary(projectDir, args.runId);
        const fixState = summary?.entries ?? [];
        const counters = summary?.counters ?? {
          bugs_filed: 0, bugs_architect_refused: 0, bugs_attempted_fix: 0,
          bugs_verified_fixed: 0, partially_verified: 0, bugs_persistent: 0,
          bugs_skipped: 0, bugs_lost_to_revision: 0,
        };

        // Collect live job handles + meta files for this run
        const liveJobs: Array<{
          jobId: string; clusterId: string; state: FixJobState;
          startedAt: string; durationMs: number; exitCode?: number;
        }> = [];

        // In-memory handles
        for (const handle of fixJobs.values()) {
          if (handle.runId !== args.runId) continue;
          liveJobs.push({
            jobId: handle.jobId,
            clusterId: handle.clusterId,
            state: handle.state,
            startedAt: new Date(handle.startedAt).toISOString(),
            durationMs: Date.now() - handle.startedAt,
            exitCode: handle.exitCode,
          });
        }

        // Meta files (handles not in memory — completed or orphaned)
        const fixJobsDir = path.join(paths.runDir, 'fix-jobs');
        if (fs.existsSync(fixJobsDir)) {
          for (const f of fs.readdirSync(fixJobsDir)) {
            if (!f.endsWith('.meta.json')) continue;
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(fixJobsDir, f), 'utf-8')) as {
                jobId: string; clusterId: string; state: FixJobState;
                startedAt: number; exitCode?: number;
              };
              if (liveJobs.some(j => j.jobId === meta.jobId)) continue;
              liveJobs.push({
                jobId: meta.jobId,
                clusterId: meta.clusterId,
                state: meta.state,
                startedAt: new Date(meta.startedAt).toISOString(),
                durationMs: Date.now() - meta.startedAt,
                exitCode: meta.exitCode,
              });
            } catch { /* skip corrupt */ }
          }
        }

        return toolOk({ ok: true, fixState, counters, liveJobs });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  // bughunt_fix_gate
  server.tool(
    'bughunt_fix_gate',
    'Run forbidden-path gate against a fix branch. Optionally reset the branch on violation.',
    FixGateInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- forbiddenPathGate is synchronous
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const result = forbiddenPathGate(projectDir, args.branch, args.baseBranch ?? 'main', args.reset ?? false);
        return toolOk({
          ok: result.ok,
          violations: result.violations,
          reset: result.ok ? false : result.reset,
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  // bughunt_fix_retest
  server.tool(
    'bughunt_fix_retest',
    'Re-replay all action logs for one cluster against the current dev server. Returns the fix verdict.',
    FixRetestInput.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const result = await retestOp(projectDir, args.runId, args.clusterId, args.baseBranch, args.branch);
        return toolOk({ ok: true, result });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
