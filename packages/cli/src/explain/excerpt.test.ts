// Excerpt + truncation tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { excerptSuspectedFiles } from './excerpt.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-excerpt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

function writeFile(relPath: string, content: string): void {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('excerptSuspectedFiles', () => {
  it('returns empty array for empty suspectedFiles', () => {
    expect(excerptSuspectedFiles([], tmpDir)).toEqual([]);
  });

  it('skips files that do not exist on disk (EC-14)', () => {
    const result = excerptSuspectedFiles(['src/does-not-exist.ts'], tmpDir);
    expect(result).toHaveLength(0);
  });

  it('reads a short file completely', () => {
    writeFile('src/foo.ts', 'const x = 1;\nconst y = 2;\n');
    const result = excerptSuspectedFiles(['src/foo.ts'], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain('const x = 1;');
    expect(result[0]?.path).toBe('src/foo.ts');
    expect(result[0]?.firstLine).toBe(1);
  });

  it('truncates files longer than 200 lines with omit line', () => {
    writeFile('src/long.ts', makeLines(250));
    const result = excerptSuspectedFiles(['src/long.ts'], tmpDir);
    expect(result).toHaveLength(1);
    const content = result[0]?.content ?? '';
    expect(content).toContain('omitted');
    expect(content).toContain('line 1');
    expect(content).toContain('line 250');
  });

  it('caps at 3 files', () => {
    writeFile('src/a.ts', 'a');
    writeFile('src/b.ts', 'b');
    writeFile('src/c.ts', 'c');
    writeFile('src/d.ts', 'd');
    const result = excerptSuspectedFiles(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      tmpDir,
    );
    expect(result).toHaveLength(3);
  });

  it('skips node_modules paths', () => {
    writeFile('node_modules/react/index.js', 'module.exports = {};');
    const result = excerptSuspectedFiles(['node_modules/react/index.js'], tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips dist/ paths', () => {
    writeFile('dist/main.js', '(() => {})();');
    const result = excerptSuspectedFiles(['dist/main.js'], tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips .next/ paths', () => {
    writeFile('.next/server/app.js', '// next internal');
    const result = excerptSuspectedFiles(['.next/server/app.js'], tmpDir);
    expect(result).toHaveLength(0);
  });
});
