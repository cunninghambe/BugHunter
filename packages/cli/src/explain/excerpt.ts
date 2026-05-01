import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SuspectedFileLike } from '../types.js';
import { suspectedFilePath } from '../types.js';

export type FileExcerpt = {
  path: string;
  firstLine: number;
  lastLine: number;
  content: string;
};

const MAX_FILE_SIZE_BYTES = 1_000_000;
const MAX_LINES = 200;
const HEAD_LINES = 100;
const TAIL_LINES = 100;
const SKIP_PATTERNS = /node_modules\/|\.next\/|dist\/|build\//;

function readTruncated(filePath: string, maxLines: number): { lines: string[] } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const all = raw.split('\n');
  if (all.length <= maxLines) return { lines: all };

  const head = all.slice(0, HEAD_LINES);
  const tail = all.slice(-TAIL_LINES);
  const omitted = all.length - HEAD_LINES - TAIL_LINES;
  return { lines: [...head, `... (omitted ${omitted} lines)`, ...tail] };
}

export function excerptSuspectedFiles(suspectedFiles: SuspectedFileLike[], projectDir: string): FileExcerpt[] {
  const results: FileExcerpt[] = [];

  for (const entry of suspectedFiles.slice(0, 3)) {
    const relPath = suspectedFilePath(entry);
    if (SKIP_PATTERNS.test(relPath)) continue;

    const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
    if (!fs.existsSync(absPath)) continue;

    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    const { lines } = readTruncated(absPath, MAX_LINES);

    results.push({
      path: relPath,
      firstLine: 1,
      lastLine: lines.length,
      content: lines.join('\n'),
    });
  }

  return results;
}
