import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeActionLog, readActionLog } from '../src/repro/action-log.js';
import type { ActionLog } from '../src/repro/action-log.js';

describe('action-log persistence', () => {
  it('writes a file at the same path that bugs.jsonl will record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-act-'));
    const log: ActionLog = {
      occurrenceId: 'occ-test-1',
      runId: 'run-1',
      role: 'owner',
      page: '/products',
      baseUrl: 'http://localhost:3000/products',
      actions: [{
        step: 0,
        kind: 'click',
        selector: 'button',
        url: 'http://localhost:3000/products',
        timestamp: '2026-01-01T00:00:00.000Z',
      }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const writtenPath = writeActionLog(dir, log);
    // The cluster phase records this exact path shape.
    expect(writtenPath).toBe(path.join(dir, 'occ-test-1.json'));
    expect(fs.existsSync(writtenPath)).toBe(true);
    const round = readActionLog(dir, 'occ-test-1');
    expect(round).toEqual(log);
  });
});
