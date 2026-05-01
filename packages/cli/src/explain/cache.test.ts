// AC-13, AC-14: cache hit/miss + sanitize behavior.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCache, writeCache, cachePath } from './cache.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cache-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

describe('cachePath', () => {
  it('returns path under .bughunter/explanations/', () => {
    const p = cachePath(tmpDir, 'console_error|foo|abc');
    expect(p).toContain(path.join('.bughunter', 'explanations'));
    expect(p).toMatch(/\.md$/);
  });

  it('sanitizes special characters in key', () => {
    const p = cachePath(tmpDir, 'kind:console_error|foo bar/baz');
    const filename = path.basename(p, '.md');
    expect(filename).not.toMatch(/[:|/\s]/);
  });

  it('caps key at 200 chars', () => {
    const longKey = 'a'.repeat(500);
    const p = cachePath(tmpDir, longKey);
    const filename = path.basename(p, '.md');
    expect(filename.length).toBeLessThanOrEqual(200);
  });
});

describe('readCache / writeCache', () => {
  it('returns undefined for a cache miss', () => {
    const result = readCache(tmpDir, 'nonexistent-key');
    expect(result).toBeUndefined();
  });

  it('round-trips write + read', () => {
    const markdown = '## What is happening\n\nA test error.';
    writeCache(tmpDir, 'test-key', markdown);
    const result = readCache(tmpDir, 'test-key');
    expect(result).toBe(markdown);
  });

  it('creates parent directory if missing', () => {
    writeCache(tmpDir, 'my-cluster-sig', '## heading\n\ncontent');
    const p = cachePath(tmpDir, 'my-cluster-sig');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('overwrites existing cached value', () => {
    writeCache(tmpDir, 'key1', 'first version');
    writeCache(tmpDir, 'key1', 'second version');
    expect(readCache(tmpDir, 'key1')).toBe('second version');
  });

  it('different keys produce different cache files', () => {
    writeCache(tmpDir, 'key-a', 'content A');
    writeCache(tmpDir, 'key-b', 'content B');
    expect(readCache(tmpDir, 'key-a')).toBe('content A');
    expect(readCache(tmpDir, 'key-b')).toBe('content B');
  });
});
