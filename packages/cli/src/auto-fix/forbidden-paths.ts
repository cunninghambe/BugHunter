// Post-hoc forbidden-path gate (§ 3.9 step 2, § 8).
// After each ClaudeMCP job: git diff <baseBranch>..<branch> --name-only,
// check against forbiddenPaths. If any match: hard-reset branch, mark bugs_skipped.

import { execSync } from 'node:child_process';
import micromatch from 'micromatch';
import { log } from '../log.js';

export type ForbiddenPathCheckResult =
  | { allowed: true; changedFiles: string[] }
  | { allowed: false; violatingPaths: string[]; changedFiles: string[] };

export function checkForbiddenPaths(
  projectDir: string,
  baseBranch: string,
  fixBranch: string,
  forbiddenPatterns: string[]
): ForbiddenPathCheckResult {
  let changedFiles: string[];
  try {
    const output = execSync(
      `git diff ${baseBranch}..${fixBranch} --name-only`,
      { cwd: projectDir, encoding: 'utf-8' }
    );
    changedFiles = output.split('\n').filter(Boolean);
  } catch (err) {
    log.warn('git diff failed for forbidden-path check', err);
    changedFiles = [];
  }

  const violating = changedFiles.filter(f => micromatch([f], forbiddenPatterns).length > 0);

  if (violating.length > 0) {
    return { allowed: false, violatingPaths: violating, changedFiles };
  }
  return { allowed: true, changedFiles };
}

// Hard-reset the fix branch to the base branch (undo all changes).
export function hardResetBranch(
  projectDir: string,
  baseBranch: string,
  fixBranch: string
): void {
  try {
    execSync(
      `git update-ref refs/heads/${fixBranch} $(git rev-parse ${baseBranch})`,
      { cwd: projectDir, stdio: 'pipe' }
    );
    log.info(`Hard-reset branch ${fixBranch} to ${baseBranch}`);
  } catch (err) {
    log.error(`Failed to hard-reset branch ${fixBranch}`, err);
    throw new Error(`Failed to hard-reset branch ${fixBranch}: ${String(err)}`);
  }
}
