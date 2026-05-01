// Shared file-system locking and atomic write utilities for V31 write-side tools.
// Uses POSIX mkdir atomicity for locks; write+rename for JSON atomic updates.

import * as fs from 'node:fs';

/**
 * Acquire a directory-based lock, run `fn`, then release.
 * Retries with jitter until `timeoutMs`. Detects stale locks (>30 s) and forces removal.
 */
export async function withLock<T>(lockDir: string, timeoutMs: number, fn: () => Promise<T> | T): Promise<T> {
  const start = Date.now();
  const STALE_MS = 30_000;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try {
        return await fn();
      } finally {
        fs.rmdirSync(lockDir);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw e;

      // Check for stale lock before timing out
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* lock may have been released between our check and stat */ }

      if (Date.now() - start > timeoutMs) {
        throw new Error('lock_timeout');
      }
      await new Promise<void>(r => { setTimeout(r, 50 + Math.random() * 100); });
    }
  }
}

/**
 * Atomically write JSON to `target` using write-then-rename.
 * Safe on POSIX when `target` and the temp file are on the same filesystem.
 */
export function atomicWriteJson(target: string, data: unknown): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, target);
}
