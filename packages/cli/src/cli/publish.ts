// bughunter publish <runId> --target github — shells to gh code-scanning upload-sarif.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runPaths } from '../store/filesystem.js';
import { exportCommand } from './export.js';

export type PublishCommandOptions = {
  runId: string;
  target: string;
  ref?: string;
  sha?: string;
  report?: string;
};

export function publishCommand(
  projectDir: string,
  opts: PublishCommandOptions,
): void {
  if (opts.target !== 'github') {
    process.stderr.write(`Invalid --target: ${opts.target}. Only 'github' is supported in v0.29.\n`);
    process.exit(2);
  }

  // Resolve report path — generate if missing.
  const paths = runPaths(projectDir, opts.runId);
  const reportPath = opts.report ?? path.join(paths.exportsDir, 'github.sarif');

  if (!fs.existsSync(reportPath)) {
    exportCommand(projectDir, {
      runId: opts.runId,
      format: 'github',
      out: reportPath,
    });
  }

  // Detect gh CLI.
  const ghCheck = spawnSync('gh', ['--version'], { stdio: 'pipe' });
  if (ghCheck.error !== undefined) {
    process.stderr.write('[bughunter] gh CLI not installed; skipping upload\n');
    process.exit(0);
  }

  // Detect git repo.
  const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: projectDir,
    stdio: 'pipe',
  });
  if (gitCheck.status !== 0) {
    process.stderr.write('[bughunter] Not inside a git repository; skipping upload\n');
    process.exit(0);
  }

  const ref = opts.ref ?? process.env['GITHUB_REF'] ?? resolveGitHead(projectDir);
  const sha = opts.sha ?? process.env['GITHUB_SHA'] ?? resolveGitSha(projectDir);

  const ghArgs = [
    'code-scanning',
    'upload-sarif',
    '--file', reportPath,
    '--ref', ref,
    '--sha', sha,
  ];

  try {
    execFileSync('gh', ghArgs, { stdio: 'inherit', cwd: projectDir });
  } catch (err) {
    const code = (err as { status?: number }).status ?? 1;
    process.exit(code);
  }
}

function resolveGitHead(projectDir: string): string {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: projectDir,
    stdio: 'pipe',
  });
  const out = result.stdout.toString().trim();
  return out.length > 0 ? out : 'HEAD';
}

function resolveGitSha(projectDir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectDir,
    stdio: 'pipe',
  });
  const out = result.stdout.toString().trim();
  return out.length > 0 ? out : 'HEAD';
}
