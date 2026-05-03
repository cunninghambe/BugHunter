// Integration smoke: spin up the fixture orchestrator, send SIGINT, assert no orphan processes.
// @slow — boots all fixture ports.
// Guard: only runs when BUGHUNTER_FIXTURE_CLEANUP_TEST=1.
// Run explicitly: BUGHUNTER_FIXTURE_CLEANUP_TEST=1 npx vitest run tests/integration/fixture-cleanup.smoke.test.ts

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UP_SCRIPT = path.join(REPO_ROOT, 'fixtures', 'bughunter-self-deliberate-bugs', 'bin', 'up.sh');
const PID_FILE = path.join(REPO_ROOT, 'fixtures', 'bughunter-self-deliberate-bugs', '.fixture-pids');

const RUN = process.env['BUGHUNTER_FIXTURE_CLEANUP_TEST'] === '1';

describe.skipIf(!RUN)('fixture cleanup on SIGINT (@slow)', () => {
  it('no orphan fixture processes survive after SIGINT to orchestrator', async () => {
    const proc = child_process.spawn('bash', [UP_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });

    // Wait for the orchestrator to write PIDs (up to 15s)
    await waitFor(
      () => fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf-8').trim().length > 0,
      15_000,
    );

    const pidEntries = fs.readFileSync(PID_FILE, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => {
        const [, pid] = l.trim().split(/\s+/);
        return parseInt(pid ?? '', 10);
      })
      .filter(n => Number.isFinite(n));

    expect(pidEntries.length).toBeGreaterThan(0);

    // Send SIGINT to the orchestrator process group
    try {
      process.kill(-proc.pid!, 'SIGINT');
    } catch {
      // orchestrator may have already exited; that's fine
    }

    // Wait up to 10s for all sub-fixture PIDs to die
    await waitFor(() => pidEntries.every(pid => !isAlive(pid)), 10_000);

    for (const pid of pidEntries) {
      expect(isAlive(pid)).toBe(false);
    }
  }, 60_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return;
    await new Promise(r => setTimeout(r, 200));
  }
}
