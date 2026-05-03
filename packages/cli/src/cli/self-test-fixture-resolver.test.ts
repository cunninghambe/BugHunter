// V54.9 — tests for the updated fixture resolver that defaults to
// comprehensive-bench instead of bughunter-self-deliberate-bugs.
//
// These tests cover the EXPORTED resolveFixtureRoot function only.
// No fixture boot, no network, no side effects.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { resolveFixtureRoot, FIXTURE_ENV_VAR } from './self-test.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal fixture directory with a marker file. */
function makeFixtureDir(root: string, markerFile: string): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, markerFile), '{}');
  return root;
}

const temps: string[] = [];

function tmpDir(): string {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fixture-test-'));
  temps.push(t);
  return t;
}

afterEach(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
  temps.length = 0;
  delete process.env[FIXTURE_ENV_VAR];
});

// ---------------------------------------------------------------------------
// FIXTURE_ENV_VAR is exported as a string constant
// ---------------------------------------------------------------------------

describe('FIXTURE_ENV_VAR', () => {
  it('is exported and equals "BUGHUNTER_BENCH_PATH"', () => {
    expect(FIXTURE_ENV_VAR).toBe('BUGHUNTER_BENCH_PATH');
  });
});

// ---------------------------------------------------------------------------
// resolveFixtureRoot — env-var override (highest priority)
// ---------------------------------------------------------------------------

describe('resolveFixtureRoot — BUGHUNTER_BENCH_PATH env var', () => {
  it('returns the env-var path when it points at a valid comprehensive-bench dir', () => {
    const benchDir = tmpDir();
    makeFixtureDir(benchDir, 'gold-standard.jsonl');
    process.env[FIXTURE_ENV_VAR] = benchDir;

    const result = resolveFixtureRoot(process.cwd());
    expect(result).toBe(benchDir);
  });

  it('throws when BUGHUNTER_BENCH_PATH is set but the directory does not exist', () => {
    process.env[FIXTURE_ENV_VAR] = '/nonexistent/bench/path/12345';

    expect(() => resolveFixtureRoot(process.cwd())).toThrow(
      /BUGHUNTER_BENCH_PATH.*does not exist/i,
    );
  });

  it('throws when BUGHUNTER_BENCH_PATH points at a dir missing gold-standard.jsonl', () => {
    const emptyDir = tmpDir();
    // No marker file — not a valid comprehensive-bench fixture
    process.env[FIXTURE_ENV_VAR] = emptyDir;

    expect(() => resolveFixtureRoot(process.cwd())).toThrow(
      /gold-standard\.jsonl.*not found/i,
    );
  });

  it('env-var takes priority over local bench default and old fixture fallback', () => {
    // Even if the old fixture exists relative to projectDir, env-var wins
    const benchDir = tmpDir();
    makeFixtureDir(benchDir, 'gold-standard.jsonl');
    process.env[FIXTURE_ENV_VAR] = benchDir;

    const fakeProjectDir = tmpDir();
    const oldFixture = path.join(fakeProjectDir, 'fixtures', 'bughunter-self-deliberate-bugs');
    makeFixtureDir(oldFixture, 'reuse-manifest.json');

    const result = resolveFixtureRoot(fakeProjectDir);
    expect(result).toBe(benchDir);
  });
});

// ---------------------------------------------------------------------------
// resolveFixtureRoot — local bench default (second priority)
// ---------------------------------------------------------------------------

describe('resolveFixtureRoot — local bench default path', () => {
  it('resolves /tmp/bench-current/apps/comprehensive-bench when it exists and env var is absent', () => {
    // This test only runs if /tmp/bench-current is actually present (CI gate)
    const localBench = '/tmp/bench-current/apps/comprehensive-bench';
    if (!fs.existsSync(path.join(localBench, 'gold-standard.jsonl'))) {
      // Bench not cloned in this environment — skip via passing trivially
      // (comment documents why; the env-var test above provides the real coverage)
      return;
    }
    delete process.env[FIXTURE_ENV_VAR];

    const result = resolveFixtureRoot('/tmp/bench-current/apps/comprehensive-bench');
    expect(result).toBe(localBench);
  });
});

// ---------------------------------------------------------------------------
// resolveFixtureRoot — old fixture fallback (lowest priority)
//
// The old-fixture fallback (priority 3) only activates when:
//   - BUGHUNTER_BENCH_PATH is unset
//   - /tmp/bench-current/apps/comprehensive-bench does NOT exist
//
// In environments where the bench is live (smoke runs), these tests skip
// rather than requiring teardown of the bench fixture.
// ---------------------------------------------------------------------------

const BENCH_LIVE = fs.existsSync('/tmp/bench-current/apps/comprehensive-bench/gold-standard.jsonl');

describe('resolveFixtureRoot — old fixture fallback', () => {
  it('falls back to bughunter-self-deliberate-bugs when no bench is available', () => {
    if (BENCH_LIVE) {
      // Bench is checked out in this environment — priority 2 always wins.
      // Test is skipped: use BUGHUNTER_BENCH_PATH test above for resolver coverage.
      return;
    }
    delete process.env[FIXTURE_ENV_VAR];

    const fakeRoot = tmpDir();
    const oldFixture = path.join(fakeRoot, 'fixtures', 'bughunter-self-deliberate-bugs');
    makeFixtureDir(oldFixture, 'reuse-manifest.json');

    const result = resolveFixtureRoot(fakeRoot);
    expect(result).toBe(path.resolve(oldFixture));
  });

  it('throws SelfTestSetupError with a helpful message when neither bench nor old fixture found', () => {
    if (BENCH_LIVE) {
      // Bench is live — no throw path reachable without removing /tmp/bench-current.
      // Covered by env-var error tests above.
      return;
    }
    delete process.env[FIXTURE_ENV_VAR];

    const emptyRoot = tmpDir();

    expect(() => resolveFixtureRoot(emptyRoot)).toThrow(
      /Cannot locate.*comprehensive-bench.*bughunter-self-deliberate-bugs/i,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveFixtureRoot — result shape
// ---------------------------------------------------------------------------

describe('resolveFixtureRoot — returned path is absolute', () => {
  it('always returns an absolute path regardless of input', () => {
    const benchDir = tmpDir();
    makeFixtureDir(benchDir, 'gold-standard.jsonl');
    process.env[FIXTURE_ENV_VAR] = benchDir;

    const result = resolveFixtureRoot('relative/path');
    expect(path.isAbsolute(result)).toBe(true);
  });
});
