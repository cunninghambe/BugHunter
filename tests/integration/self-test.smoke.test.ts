// Integration smoke test for `bughunter self-test`.
// @slow — boots fixture ports, runs the full BugHunter pipeline.
// Run explicitly: npx vitest run tests/integration/self-test.smoke.test.ts
//
// This test is NOT part of the default `npm test` invocation (see SPEC_V33_SELF_TEST.md §3.1).
// It is guarded by the BUGHUNTER_SELF_TEST_RUN env variable so it is skipped in default CI.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Guard: skip unless explicitly requested to avoid slowing down the default test run.
const RUN_SELF_TEST = process.env['BUGHUNTER_SELF_TEST_RUN'] === '1';

describe.skipIf(!RUN_SELF_TEST)('bughunter self-test smoke (@slow)', () => {
  it('selfTestCommand runs end-to-end and returns a valid result shape', async () => {
    const { selfTestCommand } = await import('../../packages/cli/src/cli/self-test.js');

    let jsonOutput = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof chunk === 'string') jsonOutput += chunk;
      return origWrite(chunk, ...rest as Parameters<typeof origWrite>[1][]);
    };

    try {
      await selfTestCommand({
        projectDir: REPO_ROOT,
        budgetMs: 1_800_000,
        maxBugs: 400,
        jsonOutput: true,
        failOnFlake: false,
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const result = JSON.parse(jsonOutput.trim().split('\n').slice(-1)[0]);

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('elapsedMs');
    expect(result).toHaveProperty('budgetMs', 1_800_000);
    expect(result).toHaveProperty('budgetOk');
    expect(result).toHaveProperty('positives');
    expect(result).toHaveProperty('negatives');
    expect(result).toHaveProperty('unexpectedKinds');
    expect(Array.isArray(result.positives)).toBe(true);
    expect(Array.isArray(result.negatives)).toBe(true);
    expect(Array.isArray(result.unexpectedKinds)).toBe(true);
    expect(result.passed).toBe(true);
  }, 1_900_000); // 31min timeout > 30min budget
});

describe('self-test lockstep (fast, always runs)', () => {
  it('assertLockstep passes on the committed fixture files', async () => {
    const { assertLockstep } = await import('../../packages/cli/src/cli/self-test.js');
    const fs = await import('node:fs');

    const manifestPath = path.join(REPO_ROOT, 'fixtures', 'bughunter-self-deliberate-bugs', 'reuse-manifest.json');
    const goldenPath = path.join(REPO_ROOT, 'fixtures', 'bughunter-self-deliberate-bugs', 'golden-bugs.jsonl');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    const goldenLines = (fs.readFileSync(goldenPath, 'utf-8') as string)
      .split('\n')
      .filter((l: string) => l.trim().length > 0)
      .map((l: string) => JSON.parse(l) as unknown);

    expect(() => assertLockstep(manifest, goldenLines)).not.toThrow();
  });
});
