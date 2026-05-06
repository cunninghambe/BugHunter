// Static-analysis tool runner framework (v0.5 T06).
// Spawns external tools, captures output, parses via Zod, emits BugDetections.

import { spawn, execFileSync } from 'node:child_process';
import type { BugDetection } from '../types.js';
import { log } from '../log.js';

const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 120_000;

export type StaticTool = {
  id: string;
  binary: string;
  args: (projectDir: string) => string[];
  parseStdout: (raw: string, projectDir: string) => { detections: BugDetection[]; warnings: string[] };
  timeoutMs: number;
  /** When true, missing binary is silently skipped with a structured-log warning. */
  optional: boolean;
};

export type StaticToolRun = {
  toolId: string;
  detections: BugDetection[];
  warnings: string[];
  skipped: boolean;
  skippedReason?: string;
};

function isOnPath(binary: string): boolean {
  try {
    execFileSync('which', [binary], { timeout: 1000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runStaticTool(tool: StaticTool, projectDir: string): Promise<StaticToolRun> {
  if (!isOnPath(tool.binary)) {
    if (tool.optional) {
      log.warn(`static: tool ${tool.id} binary '${tool.binary}' not on PATH — skipping`);
    }
    return { toolId: tool.id, detections: [], warnings: [], skipped: true, skippedReason: 'binary_not_found' };
  }

  const args = tool.args(projectDir);
  const timeoutMs = tool.timeoutMs > 0 ? tool.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(tool.binary, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill();
      log.warn(`static: tool ${tool.id} timed out after ${timeoutMs}ms`);
      resolve({ toolId: tool.id, detections: [], warnings: [`tool timed out after ${timeoutMs}ms`], skipped: true, skippedReason: 'timeout' });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_STDOUT_BYTES) {
        log.warn(`static: tool ${tool.id} stdout exceeded 50MB — truncating`);
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(stdoutChunks).toString('utf8');

      if (raw.trim() === '') {
        resolve({ toolId: tool.id, detections: [], warnings: [], skipped: false });
        return;
      }

      try {
        const { detections, warnings } = tool.parseStdout(raw, projectDir);
        if (truncated) warnings.push('stdout truncated at 50MB');
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 500);
          log.warn(`static: tool ${tool.id} exited ${code}`, { stderr });
        }
        resolve({ toolId: tool.id, detections, warnings, skipped: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`static: tool ${tool.id} parse failed: ${msg}`);
        resolve({ toolId: tool.id, detections: [], warnings: [`parse error: ${msg}`], skipped: false });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log.warn(`static: tool ${tool.id} spawn error: ${err.message}`);
      resolve({ toolId: tool.id, detections: [], warnings: [`spawn error: ${err.message}`], skipped: true, skippedReason: 'spawn_error' });
    });
  });
}

export async function runStaticAnalysis(
  projectDir: string,
  tools: StaticTool[]
): Promise<StaticToolRun[]> {
  const runs: StaticToolRun[] = [];
  for (const tool of tools) {
    runs.push(await runStaticTool(tool, projectDir));
  }
  return runs;
}
