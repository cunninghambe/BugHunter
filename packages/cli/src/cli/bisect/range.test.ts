import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { parseCommitRange } from './range.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(childProcess.execSync);

const SHA_GOOD = '0000000000000000000000000000000000000001';
const SHA_BAD  = '000000000000000000000000000000000000000a';

function setupMocks(goodSha: string, badSha: string, commitCount: number): void {
  mockExecSync.mockImplementation((cmd: unknown) => {
    const c = String(cmd);
    // ancestor check (no output needed, just no-throw)
    if (c.includes('merge-base --is-ancestor')) return '';
    // rev-list count
    if (c.includes('rev-list --count')) return String(commitCount);
    // rev-parse for goodSha ref
    if (c.includes(goodSha) || (c.includes('~30') && !c.includes(badSha))) return goodSha;
    // rev-parse for badSha ref or HEAD
    if (c.includes(badSha) || c.includes('HEAD')) return badSha;
    return goodSha;
  });
}

describe('parseCommitRange', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('parses "a..b" range', () => {
    setupMocks(SHA_GOOD, SHA_BAD, 9);
    const result = parseCommitRange(`${SHA_GOOD}..${SHA_BAD}`, '/cwd', 'HEAD~30..HEAD');
    expect(result.good).toBe(SHA_GOOD);
    expect(result.bad).toBe(SHA_BAD);
    expect(result.commitCount).toBe(9);
  });

  it('handles "a.." as a..HEAD', () => {
    setupMocks(SHA_GOOD, SHA_BAD, 19);
    const result = parseCommitRange(`${SHA_GOOD}..`, '/cwd', 'HEAD~30..HEAD');
    expect(result.good).toBe(SHA_GOOD);
    expect(result.bad).toBe(SHA_BAD);
    expect(result.commitCount).toBe(19);
  });

  it('handles "..b" as b~30..b', () => {
    let callN = 0;
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('merge-base --is-ancestor')) return '';
      if (c.includes('rev-list --count')) return '30';
      callN++;
      // first rev-parse is for b~30 → goodSha; second is for b → badSha
      return callN === 1 ? SHA_GOOD : SHA_BAD;
    });
    const result = parseCommitRange(`..${SHA_BAD}`, '/cwd', 'HEAD~30..HEAD');
    expect(result.commitCount).toBe(30);
  });

  it('uses default range when no arg', () => {
    setupMocks(SHA_GOOD, SHA_BAD, 30);
    const result = parseCommitRange(undefined, '/cwd', `${SHA_GOOD}..${SHA_BAD}`);
    expect(result.commitCount).toBe(30);
  });

  it('throws when same SHA on both sides', () => {
    mockExecSync.mockReturnValue(SHA_GOOD);
    expect(() => parseCommitRange(`${SHA_GOOD}..${SHA_GOOD}`, '/cwd', 'HEAD~30..HEAD'))
      .toThrow(/same commit/);
  });

  it('throws when ancestor check fails', () => {
    let callN = 0;
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('merge-base --is-ancestor')) throw new Error('not ancestor');
      if (c.includes('rev-list --count')) return '9';
      // alternate between good and bad sha
      callN++;
      return callN % 2 === 1 ? SHA_GOOD : SHA_BAD;
    });
    expect(() => parseCommitRange(`${SHA_GOOD}..${SHA_BAD}`, '/cwd', 'HEAD~30..HEAD'))
      .toThrow(/not an ancestor/);
  });

  it('throws on invalid format', () => {
    expect(() => parseCommitRange('notavalidrange', '/cwd', 'HEAD~30..HEAD'))
      .toThrow(/Invalid --commit-range/);
  });
});
