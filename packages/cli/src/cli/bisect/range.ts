// v0.35: commit-range parsing and validation for bughunter bisect.

import { execSync } from 'node:child_process';

export type CommitRange = {
  good: string;  // the "good" (older) commit SHA
  bad: string;   // the "bad" (newer) commit SHA
  commitCount: number;
};

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

function gitSafe(cmd: string, cwd: string): string | null {
  try {
    return git(cmd, cwd);
  } catch {
    return null;
  }
}

function resolveRef(ref: string, cwd: string): string {
  const sha = gitSafe(`rev-parse --verify "${ref}^{commit}"`, cwd);
  if (sha === null || sha === '') {
    throw new Error(`Cannot resolve ref "${ref}" — not found in git history.`);
  }
  return sha;
}

function countCommits(good: string, bad: string, cwd: string): number {
  const out = gitSafe(`rev-list --count "${good}..${bad}"`, cwd);
  return out !== null ? parseInt(out, 10) : 0;
}

function assertAncestor(ancestor: string, descendant: string, cwd: string): void {
  try {
    execSync(`git merge-base --is-ancestor "${ancestor}" "${descendant}"`, { cwd, stdio: 'ignore' });
  } catch {
    throw new Error(
      `"${ancestor}" is not an ancestor of "${descendant}". ` +
      `Ensure --commit-range <good>..<bad> has good older than bad.`,
    );
  }
}

/**
 * Parse and validate a --commit-range argument.
 * Supported forms: "a..b", "a..", "..b", or nothing (defaults to HEAD~30..HEAD).
 */
export function parseCommitRange(rangeArg: string | undefined, cwd: string, defaultRange: string): CommitRange {
  const raw = rangeArg ?? defaultRange;
  const parts = raw.split('..');

  if (parts.length !== 2) {
    throw new Error(`Invalid --commit-range "${raw}". Expected format: <good>..<bad>`);
  }

  const [leftRaw, rightRaw] = parts as [string, string];
  const left = leftRaw.trim();
  const right = rightRaw.trim();

  let goodRef: string;
  let badRef: string;

  if (left === '' && right === '') {
    throw new Error(`Invalid --commit-range "${raw}": both sides empty.`);
  } else if (left === '') {
    // ..b  → b~30..b
    badRef = right;
    goodRef = `${right}~30`;
  } else if (right === '') {
    // a..  → a..HEAD
    goodRef = left;
    badRef = 'HEAD';
  } else {
    goodRef = left;
    badRef = right;
  }

  const goodSha = resolveRef(goodRef, cwd);
  const badSha = resolveRef(badRef, cwd);

  if (goodSha === badSha) {
    throw new Error(`Commit range must include at least 2 commits: "${goodRef}" and "${badRef}" resolve to the same commit.`);
  }

  assertAncestor(goodSha, badSha, cwd);

  const commitCount = countCommits(goodSha, badSha, cwd);
  if (commitCount < 1) {
    throw new Error(`Commit range "${raw}" contains no commits between good and bad.`);
  }

  return { good: goodSha, bad: badSha, commitCount };
}

/** Return the full SHA of the current HEAD in the given directory. */
export function resolveHead(cwd: string): string {
  return resolveRef('HEAD', cwd);
}

/** Get short commit info for display. */
export function getCommitInfo(sha: string, cwd: string): { author: string; date: string; subject: string } {
  try {
    const author = git(`log -1 --format="%an <%ae>" ${sha}`, cwd);
    const date = git(`log -1 --format="%ci" ${sha}`, cwd);
    const subject = git(`log -1 --format="%s" ${sha}`, cwd);
    return { author, date, subject };
  } catch {
    return { author: 'unknown', date: 'unknown', subject: 'unknown' };
  }
}
