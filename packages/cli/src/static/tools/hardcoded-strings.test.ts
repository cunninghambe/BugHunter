// Tests for the hardcoded-string static scanner (§6).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runHardcodedStringsScanner } from './hardcoded-strings.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'bh-i18n-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmpDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

describe('runHardcodedStringsScanner', () => {
  it('returns no detections for an empty project', async () => {
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('flags a JSX text node that is a plain English string', async () => {
    await write('src/comp.tsx', `
export function Comp() {
  return <p>Submit form</p>;
}
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result.some(d => d.kind === 'i18n_hardcoded_string')).toBe(true);
  });

  it('does not flag strings wrapped in t()', async () => {
    await write('src/comp.tsx', `
export function Comp() {
  return <p>{t('Submit form')}</p>;
}
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('does not flag strings wrapped in formatMessage()', async () => {
    await write('src/comp.tsx', `
const msg = formatMessage('Hello world');
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('does not flag console.log strings', async () => {
    await write('src/comp.ts', `
console.log('Something happened');
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('does not flag import paths', async () => {
    await write('src/comp.ts', `
import { foo } from 'some-module';
const x = require('other-module');
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('skips strings marked with i18n-allow directive', async () => {
    await write('src/comp.tsx', `
// i18n-allow
const label = 'Allowed string';
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('skips strings shorter than minStringLength', async () => {
    await write('src/comp.tsx', `
const s = 'Hi';
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir, minStringLength: 5 });
    expect(result).toHaveLength(0);
  });

  it('skips strings with no whitespace when requireWhitespace is true', async () => {
    await write('src/comp.tsx', `
const key = 'SomeKey';
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir, requireWhitespace: true });
    expect(result).toHaveLength(0);
  });

  it('detections have correct shape', async () => {
    await write('src/comp.tsx', `
export function Comp() {
  return <p>Submit form</p>;
}
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    const d = result[0];
    expect(d?.kind).toBe('i18n_hardcoded_string');
    expect(d?.rootCause).toContain('Submit form');
    expect(d?.staticContext?.tool).toBe('hardcoded-strings');
    expect((d?.evidence as { clusterKey?: string })?.clusterKey).toContain(':');
  });

  it('does not scan test files', async () => {
    await write('src/comp.test.tsx', `
export function Comp() {
  return <p>Test string here</p>;
}
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('does not scan node_modules', async () => {
    await write('node_modules/lib/index.ts', `
const msg = 'This is a user string';
`);
    const result = await runHardcodedStringsScanner({ projectRoot: tmpDir });
    expect(result).toHaveLength(0);
  });

  it('respects extraExcludes pattern', async () => {
    await write('src/generated/comp.tsx', `
const msg = 'This is a user string';
`);
    const result = await runHardcodedStringsScanner({
      projectRoot: tmpDir,
      extraExcludes: ['*/generated/*'],
    });
    expect(result).toHaveLength(0);
  });

  it('respects custom translationCallsites', async () => {
    await write('src/comp.tsx', `
const msg = myCustomTranslate('Hello world');
`);
    const result = await runHardcodedStringsScanner({
      projectRoot: tmpDir,
      translationCallsites: ['myCustomTranslate('],
    });
    expect(result).toHaveLength(0);
  });
});
