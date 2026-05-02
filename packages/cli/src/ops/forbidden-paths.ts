// forbidden-path-gate op — called by the /bughunt fix skill (§ 3.9.1).
// Checks changed files on a fix branch against the configured forbiddenPaths list.

import { execFileSync } from 'node:child_process';
import micromatch from 'micromatch';
import { loadConfig } from '../config.js';
import { effectiveForbiddenPaths } from '../config.js';

export type ForbiddenPathGateResult =
  | { ok: true; violations: [] }
  | { ok: false; violations: string[]; reset: boolean };

// Validates a git ref name against a strict charset and git's own refuse-patterns.
// Throws on invalid input — callers must call this before passing user input to git.
export function validateGitRef(s: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(s)) {
    throw new Error(`Invalid git ref: ${JSON.stringify(s)}`);
  }
  if (s.startsWith('.') || s.endsWith('.')) {
    throw new Error(`Invalid git ref (leading/trailing dot): ${JSON.stringify(s)}`);
  }
  if (s.includes('..')) {
    throw new Error(`Invalid git ref (contains '..'): ${JSON.stringify(s)}`);
  }
  if (s.includes('@{')) {
    throw new Error(`Invalid git ref (contains '@{'): ${JSON.stringify(s)}`);
  }
  if (s.includes('\\')) {
    throw new Error(`Invalid git ref (contains backslash): ${JSON.stringify(s)}`);
  }
  return s;
}

export function forbiddenPathGate(
  projectDir: string,
  branch: string,
  baseBranch: string,
  doReset: boolean,
): ForbiddenPathGateResult {
  validateGitRef(branch);
  validateGitRef(baseBranch);

  const config = loadConfig(projectDir);
  const patterns = effectiveForbiddenPaths(config);

  let changedFiles: string[];
  try {
    const output = execFileSync(
      'git',
      ['diff', `${baseBranch}..${branch}`, '--name-only'],
      { cwd: projectDir, encoding: 'utf-8' },
    );
    changedFiles = output.split('\n').filter(Boolean);
  } catch {
    changedFiles = [];
  }

  const violations = changedFiles.filter(f => micromatch([f], patterns).length > 0);

  if (violations.length === 0) {
    return { ok: true, violations: [] };
  }

  if (doReset) {
    const baseSha = execFileSync(
      'git', ['rev-parse', baseBranch],
      { cwd: projectDir, encoding: 'utf-8' },
    ).trim();
    execFileSync(
      'git', ['update-ref', `refs/heads/${branch}`, baseSha],
      { cwd: projectDir, stdio: 'pipe' },
    );
  }

  return { ok: false, violations, reset: doReset };
}
