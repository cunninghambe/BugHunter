import { describe, it, expect, vi, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { createWorktree, removeWorktree, bisectStart, bisectBad, bisectGood, getBisectBadRef } from './worktree.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

const mockExecSync = vi.mocked(childProcess.execSync);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);

describe('worktree helpers', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('createWorktree calls git worktree add', () => {
    mockExecSync.mockReturnValue('');
    createWorktree('/tmp/wt/abc', 'deadbeef', '/repo');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.anything(),
    );
  });

  it('removeWorktree calls git worktree remove --force', () => {
    mockExecSync.mockReturnValue('');
    removeWorktree('/tmp/wt/abc', '/repo');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('worktree remove --force'),
      expect.anything(),
    );
  });

  it('bisectStart calls git bisect start', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    bisectStart('/tmp/wt');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['bisect', 'start'], expect.anything());
  });

  it('bisectBad calls git bisect bad', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    bisectBad('/tmp/wt', 'deadbeef');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['bisect', 'bad', 'deadbeef'], expect.anything());
  });

  it('bisectGood calls git bisect good', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    bisectGood('/tmp/wt', 'cafebabe');
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['bisect', 'good', 'cafebabe'], expect.anything());
  });

  it('getBisectBadRef returns null on error', () => {
    mockExecSync.mockImplementation(() => { throw new Error('no ref'); });
    expect(getBisectBadRef('/tmp/wt')).toBeNull();
  });

  it('getBisectBadRef returns SHA on success', () => {
    mockExecSync.mockReturnValue('abcdef1234567890abcdef1234567890abcdef12\n');
    expect(getBisectBadRef('/tmp/wt')).toBe('abcdef1234567890abcdef1234567890abcdef12');
  });
});
