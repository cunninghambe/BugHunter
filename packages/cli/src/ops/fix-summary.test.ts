import { describe, it, expect } from 'vitest';
import { tally, computeFixSummary } from './fix-summary.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('tally', () => {
  it('counts zeros for empty input', () => {
    const c = tally([]);
    expect(c.bugs_filed).toBe(0);
    expect(c.bugs_verified_fixed).toBe(0);
  });

  it('counts verified_fixed correctly', () => {
    const c = tally([
      { clusterId: 'a', verdict: 'verified_fixed' },
      { clusterId: 'b', verdict: 'not_fixed' },
    ]);
    expect(c.bugs_filed).toBe(2);
    expect(c.bugs_attempted_fix).toBe(2);
    expect(c.bugs_verified_fixed).toBe(1);
    expect(c.bugs_persistent).toBe(1);
  });

  it('counts architect_refused as skipped', () => {
    const c = tally([{ clusterId: 'x', verdict: 'architect_refused' }]);
    expect(c.bugs_architect_refused).toBe(1);
    expect(c.bugs_skipped).toBe(1);
    expect(c.bugs_attempted_fix).toBe(0);
  });

  it('counts static verdicts', () => {
    const c = tally([
      { clusterId: 'a', verdict: 'verified_fixed_static' },
      { clusterId: 'b', verdict: 'not_fixed_static' },
      { clusterId: 'c', verdict: 'partially_verified_static' },
    ]);
    expect(c.bugs_verified_fixed).toBe(1);
    expect(c.bugs_persistent).toBe(1);
    expect(c.partially_verified).toBe(1);
  });

  it('verified_fixed_by_removal counts as fixed', () => {
    const c = tally([{ clusterId: 'r', verdict: 'verified_fixed_by_removal' }]);
    expect(c.bugs_verified_fixed).toBe(1);
    expect(c.bugs_attempted_fix).toBe(1);
  });
});

describe('computeFixSummary', () => {
  it('returns null when fix-state.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fixsum-'));
    try {
      expect(computeFixSummary(dir, 'run1')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('parses fix-state.json and returns correct counters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-fixsum-'));
    try {
      const runDir = path.join(dir, '.bughunter', 'runs', 'run1');
      fs.mkdirSync(runDir, { recursive: true });
      const entries = [
        { clusterId: 'a', verdict: 'verified_fixed' },
        { clusterId: 'b', verdict: 'not_fixed' },
      ];
      fs.writeFileSync(path.join(runDir, 'fix-state.json'), JSON.stringify(entries));
      const summary = computeFixSummary(dir, 'run1');
      expect(summary).not.toBeNull();
      expect(summary!.counters.bugs_filed).toBe(2);
      expect(summary!.counters.bugs_verified_fixed).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
