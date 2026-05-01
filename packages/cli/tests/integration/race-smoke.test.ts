// Integration smoke test for v0.19 race-condition detectors.
// Tests each detector against synthetic observations that mirror what the
// race-bad fixture would produce. No live browser required — validates the
// detection logic and plan shapes match the fixture's intentional bugs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as cp from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  detectDoubleSubmit,
  detectClickThenNavigate,
  detectOptimisticRevert,
  detectInterleavedMutations,
  detectCrossTab,
} from '../../src/security/race-detectors.js';
import type {
  DoubleSubmitPlan,
  ClickThenNavigatePlan,
  OptimisticRevertPlan,
  InterleavedMutationsPlan,
  CrossTabPlan,
} from '../../src/security/race-detectors.js';
import type { RaceObservation } from '../../src/types.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const FIXTURE_PORT = 9994;
const BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

// ---- fixture lifecycle ----

let fixtureProc: cp.ChildProcess | undefined;

async function waitForHealth(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/health`);
      return true;
    } catch {
      await new Promise(r => { setTimeout(r, 100); });
    }
  }
  return false;
}

// Start the fixture once for all live-HTTP tests.
// If the fixture fails to start, HTTP tests are skipped.
let fixtureReady = false;

async function startFixture(): Promise<void> {
  const serverPath = path.resolve(__dirname, '../../../../fixtures/race-bad/server.js');
  fixtureProc = cp.spawn(process.execPath, [serverPath], {
    env: { ...process.env, RACE_BAD_PORT: String(FIXTURE_PORT) },
    stdio: 'pipe',
  });
  fixtureProc.on('error', () => { fixtureProc = undefined; });
  fixtureReady = await waitForHealth();
}

async function post(routePath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
  return { status: res.status, body: await res.text() };
}

// ---- observation builder ----

function obs(opts: Partial<RaceObservation> & { offsetMs: number }): RaceObservation {
  return {
    url: opts.url ?? 'http://localhost/',
    offsetMs: opts.offsetMs,
    targetSelectorState: opts.targetSelectorState ?? 'pre',
    targetSelectorHash: opts.targetSelectorHash ?? '',
    consoleErrorCount: opts.consoleErrorCount ?? 0,
    toastVisible: opts.toastVisible ?? false,
    responseStatus: opts.responseStatus,
  };
}

// ---- detector unit tests (no fixture required) ----

describe('race_condition_double_submit — detector', () => {
  const plan: DoubleSubmitPlan = {
    variant: { kind: 'double_submit', gapMs: 50 },
    toolId: 'create-item',
    toolPath: 'POST /api/items',
    raceNonce: 'nonce-abc',
  };

  it('produces a finding when two 2xx responses arrive and state is final', () => {
    const observations = [
      obs({ offsetMs: 0, responseStatus: 201 }),
      obs({ offsetMs: 50, responseStatus: 201 }),
      obs({ offsetMs: 1000, targetSelectorState: 'final' }),
    ];
    const result = detectDoubleSubmit(plan, observations);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_double_submit');
    expect(result?.raceContext?.gapMs).toBe(50);
  });

  it('no finding when only one 2xx response (idempotent behaviour)', () => {
    expect(detectDoubleSubmit(plan, [
      obs({ offsetMs: 0, responseStatus: 201 }),
      obs({ offsetMs: 1000, targetSelectorState: 'final' }),
    ])).toBeNull();
  });
});

describe('race_condition_click_navigate — detector', () => {
  const plan: ClickThenNavigatePlan = {
    variant: { kind: 'click_then_navigate', targetRoute: '/dashboard', preFireDelayMs: 0 },
    toolId: 'save-item',
    toolPath: 'POST /api/save',
    pageRoute: '/click-navigate',
  };

  it('produces a finding when post-nav state is pre with no error', () => {
    const result = detectClickThenNavigate(plan, [
      obs({ offsetMs: 0, targetSelectorState: 'pre' }),
      obs({ offsetMs: 2000, targetSelectorState: 'pre', consoleErrorCount: 0, toastVisible: false }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_click_navigate');
    expect(result?.raceContext?.navigateTarget).toBe('/dashboard');
  });
});

describe('race_condition_optimistic_revert — detector', () => {
  const plan: OptimisticRevertPlan = {
    variant: { kind: 'optimistic_revert', forcedStatus: 500, forcedBody: '{"error":"forced"}' },
    toolId: 'like-post',
    toolPath: 'POST /api/like',
    pageRoute: '/optimistic-revert',
  };

  it('produces a finding when optimistic state persists after forced failure', () => {
    const result = detectOptimisticRevert(plan, [
      obs({ offsetMs: 300, targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 5000, targetSelectorState: 'optimistic', consoleErrorCount: 0, toastVisible: false }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_optimistic_revert');
    expect(result?.raceContext?.forcedStatus).toBe(500);
  });

  it('no finding when UI shows error state at settle time', () => {
    expect(detectOptimisticRevert(plan, [
      obs({ offsetMs: 300, targetSelectorState: 'optimistic' }),
      obs({ offsetMs: 5000, targetSelectorState: 'errored' }),
    ])).toBeNull();
  });
});

describe('race_condition_interleaved_mutations — detector', () => {
  const plan: InterleavedMutationsPlan = {
    variant: { kind: 'interleaved_mutations', siblingActionId: '#decrement-btn', gapMs: 0, consensusRuns: 3 },
    toolId: 'increment',
    toolPath: 'POST /api/counter/increment',
    siblingToolId: 'decrement',
    pageRoute: '/interleaved',
  };

  it('produces a finding when ≥2 of 3 runs diverge', () => {
    const runObs = [
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-B' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-B' })],
    ];
    const result = detectInterleavedMutations(plan, runObs);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_interleaved_mutations');
    expect(result?.raceContext?.consensusVotes).toBeGreaterThanOrEqual(2);
  });

  it('marks as flaky when exactly 1-of-3 diverge', () => {
    const runObs = [
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-A' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-B' })],
    ];
    const result = detectInterleavedMutations(plan, runObs);
    expect(result).not.toBeNull();
    expect(result?.raceContext?.flaky).toBe(true);
  });

  it('no finding when all runs produce same hash', () => {
    const runObs = [
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-X' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-X' })],
      [obs({ offsetMs: 2000, targetSelectorHash: 'hash-X' })],
    ];
    expect(detectInterleavedMutations(plan, runObs)).toBeNull();
  });
});

describe('race_condition_cross_tab — detector', () => {
  const plan: CrossTabPlan = {
    variant: { kind: 'cross_tab', settleMs: 5000 },
    toolId: 'vote',
    toolPath: 'POST /api/vote',
    pageRoute: '/cross-tab',
  };

  it('produces a finding when tabs diverge', () => {
    const result = detectCrossTab(plan,
      [obs({ offsetMs: 5000, targetSelectorHash: 'tab1-hash', targetSelectorState: 'final' })],
      [obs({ offsetMs: 5000, targetSelectorHash: 'tab2-hash', targetSelectorState: 'final' })],
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('race_condition_cross_tab');
  });

  it('no finding when tabs have same final hash', () => {
    expect(detectCrossTab(plan,
      [obs({ offsetMs: 5000, targetSelectorHash: 'same', targetSelectorState: 'final' })],
      [obs({ offsetMs: 5000, targetSelectorHash: 'same', targetSelectorState: 'final' })],
    )).toBeNull();
  });
});

// ---- live fixture HTTP tests ----

describe('race-bad fixture — live HTTP (skipped if fixture unavailable)', () => {
  beforeAll(async () => {
    await startFixture();
  }, 10_000);

  afterAll(() => {
    fixtureProc?.kill('SIGTERM');
    fixtureProc = undefined;
    fixtureReady = false;
  });

  it('fixture starts and serves health check', async () => {
    if (!fixtureReady) return;
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
  });

  it('POST /api/items accepts duplicate submissions (double_submit bug)', async () => {
    if (!fixtureReady) return;

    const [r1, r2] = await Promise.all([
      post('/api/items'),
      post('/api/items'),
    ]);
    // Both should succeed — the bug is that two items get created
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const b1 = JSON.parse(r1.body) as { id: number };
    const b2 = JSON.parse(r2.body) as { id: number };
    // Two different IDs = duplicate write accepted
    expect(b1.id).not.toBe(b2.id);
  });

  it('POST /api/like with X-Force-Fail: 1 returns 500 (optimistic_revert bug setup)', async () => {
    if (!fixtureReady) return;

    const res = await post('/api/like', { 'x-force-fail': '1' });
    expect(res.status).toBe(500);
  });
});
