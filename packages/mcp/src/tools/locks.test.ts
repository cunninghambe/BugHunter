import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withLock, atomicWriteJson } from './locks.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bh-locks-'));
}

describe('withLock', () => {
  let dir = '';
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('runs fn and releases lock', async () => {
    dir = tmpDir();
    const lockDir = path.join(dir, 'test.lock');
    const result = await withLock(lockDir, 1000, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('releases lock even when fn throws', async () => {
    dir = tmpDir();
    const lockDir = path.join(dir, 'test.lock');
    await expect(withLock(lockDir, 1000, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('serializes concurrent callers', async () => {
    dir = tmpDir();
    const lockDir = path.join(dir, 'test.lock');
    const order: number[] = [];
    await Promise.all([
      withLock(lockDir, 2000, async () => { order.push(1); await new Promise<void>(r => { setTimeout(r, 20); }); order.push(2); }),
      withLock(lockDir, 2000, async () => { order.push(3); }),
    ]);
    // First call must fully complete before second starts
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  it('times out if lock is held past timeoutMs', async () => {
    dir = tmpDir();
    const lockDir = path.join(dir, 'test.lock');
    fs.mkdirSync(lockDir); // simulate held lock
    await expect(withLock(lockDir, 100, () => 1)).rejects.toThrow('lock_timeout');
    fs.rmdirSync(lockDir);
  });

  it('force-releases stale lock (>30s)', async () => {
    dir = tmpDir();
    const lockDir = path.join(dir, 'test.lock');
    fs.mkdirSync(lockDir);
    // Backdate mtime by 31 seconds
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(lockDir, staleTime, staleTime);
    const result = await withLock(lockDir, 500, () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('atomicWriteJson', () => {
  let dir = '';
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes JSON to target', () => {
    dir = tmpDir();
    const target = path.join(dir, 'out.json');
    atomicWriteJson(target, { x: 1 });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ x: 1 });
  });

  it('leaves no .tmp file behind', () => {
    dir = tmpDir();
    const target = path.join(dir, 'out.json');
    atomicWriteJson(target, {});
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toHaveLength(0);
  });

  it('overwrites existing file atomically', () => {
    dir = tmpDir();
    const target = path.join(dir, 'out.json');
    atomicWriteJson(target, { v: 1 });
    atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ v: 2 });
  });
});
