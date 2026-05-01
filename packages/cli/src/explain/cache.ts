import * as fs from 'node:fs';
import * as path from 'node:path';
import { bugHunterPaths } from '../suppress/io.js';

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}

export function cachePath(projectDir: string, cacheKey: string): string {
  const paths = bugHunterPaths(projectDir);
  return path.join(paths.explanationsDir, `${sanitizeKey(cacheKey)}.md`);
}

export function readCache(projectDir: string, cacheKey: string): string | undefined {
  const p = cachePath(projectDir, cacheKey);
  if (!fs.existsSync(p)) return undefined;
  return fs.readFileSync(p, 'utf-8');
}

export function writeCache(projectDir: string, cacheKey: string, markdown: string): void {
  const p = cachePath(projectDir, cacheKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, markdown, 'utf-8');
}
