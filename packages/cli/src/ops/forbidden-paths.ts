// forbidden-path-gate op — called by the /bughunt fix skill (§ 3.9.1).
// Checks changed files on a fix branch against the configured forbiddenPaths list.

import { execSync } from 'node:child_process';
import micromatch from 'micromatch';
import { loadConfig } from '../config.js';
import { effectiveForbiddenPaths } from '../config.js';

export type ForbiddenPathGateResult =
  | { ok: true; violations: [] }
  | { ok: false; violations: string[]; reset: boolean };

export function forbiddenPathGate(
  projectDir: string,
  branch: string,
  baseBranch: string,
  doReset: boolean,
): ForbiddenPathGateResult {
  const config = loadConfig(projectDir);
  const patterns = effectiveForbiddenPaths(config);

  let changedFiles: string[];
  try {
    const output = execSync(
      `git diff ${baseBranch}..${branch} --name-only`,
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
    execSync(
      `git update-ref refs/heads/${branch} $(git rev-parse ${baseBranch})`,
      { cwd: projectDir, stdio: 'pipe' },
    );
  }

  return { ok: false, violations, reset: doReset };
}
