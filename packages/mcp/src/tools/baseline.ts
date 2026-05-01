// bughunt_baseline_save / bughunt_baseline_compare — visual and perf baseline management.

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir, runPaths, readRunSummary } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import type { RunSummary } from 'bughunter/src/types.js';
import { loadConfig } from 'bughunter/src/config.js';

const BaselineSaveInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(['visual', 'perf']),
});

const BaselineCompareInput = z.object({
  project: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum(['visual', 'perf']).optional(),
});

function baselinesDir(projectDir: string): string {
  return path.join(projectDir, '.bughunter', 'baselines');
}

function sha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function atomicSymlinkSwap(target: string, linkPath: string): void {
  const tmp = `${linkPath}.tmp.${process.pid}`;
  try { fs.unlinkSync(tmp); } catch { /* ok */ }
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, linkPath);
}

function saveVisualBaseline(
  projectDir: string,
  runId: string,
  screenshotsDir: string,
  summary: RunSummary,
): { baselinePath: string; artifactCount: number } {
  if ((summary.vision?.called ?? 0) === 0) {
    throw new InvalidArgumentError('no visual artifacts in this run (vision.called = 0)');
  }

  const pngFiles = fs.readdirSync(screenshotsDir).filter(f => f.endsWith('.png'));
  if (pngFiles.length === 0) {
    throw new InvalidArgumentError('no visual artifacts in this run (screenshots/ is empty)');
  }

  const baselineDir = path.join(baselinesDir(projectDir), 'visual', runId);
  fs.mkdirSync(baselineDir, { recursive: true });

  const files: Array<{ path: string; sha256: string }> = [];
  for (const f of pngFiles) {
    const src = path.join(screenshotsDir, f);
    const dest = path.join(baselineDir, f);
    fs.copyFileSync(src, dest);
    files.push({ path: f, sha256: sha256(src) });
  }

  const manifest = { runId, savedAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(baselineDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const currentLink = path.join(baselinesDir(projectDir), 'visual', 'current');
  atomicSymlinkSwap(runId, currentLink);

  return { baselinePath: baselineDir, artifactCount: files.length };
}

function savePerfBaseline(
  projectDir: string,
  runId: string,
  summary: RunSummary,
): { baselinePath: string; artifactCount: number } {
  if (summary.perfSummary === undefined) {
    throw new InvalidArgumentError('no perf artifacts in this run (perfSummary missing from summary.json)');
  }

  const baselineDir = path.join(baselinesDir(projectDir), 'perf', runId);
  fs.mkdirSync(baselineDir, { recursive: true });

  const metrics = summary.perfSummary;
  const perfJson = { runId, savedAt: new Date().toISOString(), metrics };
  fs.writeFileSync(path.join(baselineDir, 'perf.json'), `${JSON.stringify(perfJson, null, 2)}\n`);

  const manifest = { runId, savedAt: perfJson.savedAt, metrics };
  fs.writeFileSync(path.join(baselineDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const currentLink = path.join(baselinesDir(projectDir), 'perf', 'current');
  atomicSymlinkSwap(runId, currentLink);

  return { baselinePath: baselineDir, artifactCount: 1 };
}

type VisualRegressionResult = {
  regressions: Array<{ file: string; diffPixels: number; diffRatio: number; baselinePath: string; currentPath: string }>;
  unchanged: number;
  improvements: number;
};

type PerfRegressionResult = {
  regressions: Array<{ metric: string; baseline: number; current: number; delta: number; regressionPct: number }>;
  unchanged: number;
  improvements: number;
};

function compareVisual(projectDir: string, runId: string, screenshotsDir: string): VisualRegressionResult {
  const currentLink = path.join(baselinesDir(projectDir), 'visual', 'current');
  if (!fs.existsSync(currentLink)) {
    throw new NotFoundError('no visual baseline locked yet');
  }

  const baselineDir = path.join(baselinesDir(projectDir), 'visual', fs.readlinkSync(currentLink));
  const manifestPath = path.join(baselineDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new NotFoundError('visual baseline manifest missing');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    files: Array<{ path: string; sha256: string }>;
  };

  // V31 stub: compareVisualBaseline from V13 vision module not yet exposed.
  // Return zero-diff result based on sha256 comparison; full pixelmatch deferred to V32.
  // Filed follow-up: v0.13-finish
  let unchanged = 0;
  const regressions: VisualRegressionResult['regressions'] = [];

  for (const bf of manifest.files) {
    const currentPath = path.join(screenshotsDir, bf.path);
    const baselinePath = path.join(baselineDir, bf.path);

    if (!fs.existsSync(currentPath)) continue;

    const currentHash = sha256(currentPath);
    if (currentHash === bf.sha256) {
      unchanged++;
    } else {
      // Stub: treat any hash difference as a regression with diffPixels=0 (actual diff needs V13)
      regressions.push({
        file: bf.path,
        diffPixels: 0,
        diffRatio: 0,
        baselinePath,
        currentPath,
      });
    }
  }

  return { regressions, unchanged, improvements: 0 };
}

function comparePerf(
  projectDir: string,
  runId: string,
  summary: RunSummary,
  regressionThresholdPct: number,
): PerfRegressionResult {
  const currentLink = path.join(baselinesDir(projectDir), 'perf', 'current');
  if (!fs.existsSync(currentLink)) {
    throw new NotFoundError('no perf baseline locked yet');
  }

  const baselineDir = path.join(baselinesDir(projectDir), 'perf', fs.readlinkSync(currentLink));
  const perfPath = path.join(baselineDir, 'perf.json');
  if (!fs.existsSync(perfPath)) {
    throw new NotFoundError('perf baseline data missing');
  }

  const baselineData = JSON.parse(fs.readFileSync(perfPath, 'utf-8')) as {
    metrics: RunSummary['perfSummary'];
  };

  if (summary.perfSummary === undefined || baselineData.metrics === undefined) {
    return { regressions: [], unchanged: 0, improvements: 0 };
  }

  const regressions: PerfRegressionResult['regressions'] = [];
  let unchanged = 0;
  let improvements = 0;

  // Compare longestTaskMs
  const bLong = baselineData.metrics.longestTaskMs;
  const cLong = summary.perfSummary.longestTaskMs;
  const deltaLong = cLong - bLong;
  const pctLong = bLong > 0 ? deltaLong / bLong : 0;
  if (pctLong > regressionThresholdPct) {
    regressions.push({ metric: 'longestTaskMs', baseline: bLong, current: cLong, delta: deltaLong, regressionPct: pctLong });
  } else if (deltaLong < 0) {
    improvements++;
  } else {
    unchanged++;
  }

  void runId; // recorded in baseline manifest
  return { regressions, unchanged, improvements };
}

export function registerBaselineTools(server: McpServer): void {
  server.tool(
    'bughunt_baseline_save',
    'Lock the current run\'s visual or perf metrics as the baseline. Future runs compare against this baseline.',
    BaselineSaveInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous file ops
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const paths = runPaths(projectDir, args.runId);

        if (!fs.existsSync(paths.runDir)) {
          return toolErr('not_found', `run ${args.runId} not found`);
        }

        let summary: RunSummary;
        try {
          summary = readRunSummary(projectDir, args.runId);
        } catch (e) {
          if (e instanceof NotFoundError) return toolErr('not_found', e.message);
          return toolErr('error', String(e));
        }

        let baselinePath: string;
        let artifactCount: number;

        if (args.kind === 'visual') {
          ({ baselinePath, artifactCount } = saveVisualBaseline(projectDir, args.runId, paths.screenshotsDir, summary));
        } else {
          ({ baselinePath, artifactCount } = savePerfBaseline(projectDir, args.runId, summary));
        }

        return toolOk({ ok: true, baselinePath, artifactCount });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        return toolErr('error', String(e));
      }
    },
  );

  server.tool(
    'bughunt_baseline_compare',
    'Compare the current run against the locked baseline. Returns regressions, unchanged, and improvements for visual and/or perf.',
    BaselineCompareInput.shape,
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous file ops
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const paths = runPaths(projectDir, args.runId);

        if (!fs.existsSync(paths.runDir)) {
          return toolErr('not_found', `run ${args.runId} not found`);
        }

        let summary: RunSummary | undefined;
        try {
          summary = readRunSummary(projectDir, args.runId);
        } catch {
          summary = undefined;
        }

        const kinds = args.kind !== undefined ? [args.kind] : (['visual', 'perf'] as const);
        const result: {
          ok: boolean;
          visual?: VisualRegressionResult;
          perf?: PerfRegressionResult;
        } = { ok: true };

        // Regression threshold: always 10% in V31; V32 will read from config.perfBudget.
        // loadConfig imported for future use — avoids unused-import warning.
        void loadConfig;
        const regressionThresholdPct = 0.10;

        for (const kind of kinds) {
          if (kind === 'visual') {
            try {
              result.visual = compareVisual(projectDir, args.runId, paths.screenshotsDir);
            } catch (e) {
              if (e instanceof NotFoundError) return toolErr('not_found', e.message);
            }
          } else {
            if (summary === undefined) continue;
            try {
              result.perf = comparePerf(projectDir, args.runId, summary, regressionThresholdPct);
            } catch (e) {
              if (e instanceof NotFoundError) return toolErr('not_found', e.message);
            }
          }
        }

        return toolOk(result);
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
