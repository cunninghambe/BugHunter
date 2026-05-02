// v0.35: worktree management for bughunter bisect.
// One worktree per bisect ID, reused across commits.

import { execSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

/** Create a git worktree for the bisect session. */
export function createWorktree(worktreePath: string, sha: string, repoDir: string): void {
  fs.mkdirSync(worktreePath, { recursive: true });
  // Remove the dir git complains if it already has files
  fs.rmSync(worktreePath, { recursive: true, force: true });
  execSync(`git worktree add "${worktreePath}" "${sha}"`, {
    cwd: repoDir,
    stdio: 'ignore',
  });
}

/** Remove a git worktree. */
export function removeWorktree(worktreePath: string, repoDir: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoDir,
      stdio: 'ignore',
    });
  } catch {
    // Best effort — clean up the directory even if git worktree remove fails
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch { /* nothing more to do */ }
  }
}

/** Initialize git bisect in the worktree. */
export function bisectStart(worktreeDir: string): void {
  execFileSync('git', ['bisect', 'start'], { cwd: worktreeDir, stdio: 'ignore' });
}

/** Mark a commit as bad (bug present) in the worktree's bisect. */
export function bisectBad(worktreeDir: string, sha: string): void {
  execFileSync('git', ['bisect', 'bad', sha], { cwd: worktreeDir, stdio: 'ignore' });
}

/** Mark a commit as good (bug absent) in the worktree's bisect. */
export function bisectGood(worktreeDir: string, sha: string): void {
  execFileSync('git', ['bisect', 'good', sha], { cwd: worktreeDir, stdio: 'ignore' });
}

/** Reset bisect state in the worktree. */
export function bisectReset(worktreeDir: string): void {
  try {
    execFileSync('git', ['bisect', 'reset'], { cwd: worktreeDir, stdio: 'ignore' });
  } catch { /* ignore if already reset */ }
}

/** Get the SHA that git bisect identified as the first bad commit. */
export function getBisectBadRef(worktreeDir: string): string | null {
  try {
    const sha = execSync('git rev-parse refs/bisect/bad', {
      cwd: worktreeDir,
      encoding: 'utf-8',
    }).trim();
    return sha !== '' ? sha : null;
  } catch {
    return null;
  }
}

/** Get current HEAD SHA in the worktree. */
export function getWorktreeHead(worktreeDir: string): string {
  return execSync('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf-8' }).trim();
}

/** Check if a SHA is reachable in the worktree. */
export function shaExists(sha: string, worktreeDir: string): boolean {
  try {
    execSync(`git rev-parse "${sha}^{commit}"`, { cwd: worktreeDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** List existing worktrees for the repo. */
export function listWorktrees(repoDir: string): string[] {
  try {
    const out = execSync('git worktree list --porcelain', { cwd: repoDir, encoding: 'utf-8' });
    return out.split('\n')
      .filter(l => l.startsWith('worktree '))
      .map(l => l.slice('worktree '.length).trim());
  } catch {
    return [];
  }
}
