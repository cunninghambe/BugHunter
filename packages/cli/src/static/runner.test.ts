// Tests for static-analysis runner framework (v0.5 T06).

import { describe, it, expect } from 'vitest';
import { runStaticTool } from './runner.js';
import type { StaticTool } from './runner.js';

function makeEchoTool(jsonOutput: string): StaticTool {
  return {
    id: 'echo-tool',
    binary: 'echo',
    args: (_dir) => [jsonOutput],
    timeoutMs: 5000,
    optional: false,
    parseStdout: (raw) => ({
      detections: [{ kind: 'console_error' as const, rootCause: raw.trim() }],
      warnings: [],
    }),
  };
}

describe('runStaticTool', () => {
  it('returns skipped when binary not on PATH', async () => {
    const tool: StaticTool = {
      id: 'nonexistent-tool',
      binary: 'bughunter-test-nonexistent-binary-xyz',
      args: (_dir) => [],
      timeoutMs: 5000,
      optional: true,
      parseStdout: () => ({ detections: [], warnings: [] }),
    };
    const result = await runStaticTool(tool, '/tmp');
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe('binary_not_found');
  });

  it('runs echo tool and parses stdout', async () => {
    const tool = makeEchoTool('hello-detection');
    const result = await runStaticTool(tool, '/tmp');
    expect(result.skipped).toBe(false);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].rootCause).toBe('hello-detection');
  });

  it('handles timeout gracefully', async () => {
    const tool: StaticTool = {
      id: 'sleep-tool',
      binary: 'sleep',
      args: (_dir) => ['60'],
      timeoutMs: 100,
      optional: false,
      parseStdout: () => ({ detections: [], warnings: [] }),
    };
    const result = await runStaticTool(tool, '/tmp');
    expect(result.skipped).toBe(true);
    expect(result.skippedReason).toBe('timeout');
  });
});
