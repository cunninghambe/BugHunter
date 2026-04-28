// Tests for ClaudeCliVisionClient (v0.5 T04).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ClaudeCliVisionClient } from './vision-claude-cli.js';
import type { VisionRequest } from './vision-client.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../../tests/fixtures/vision-cli'
);
const FAKE_CLAUDE = path.join(FIXTURE_DIR, 'fake-claude');

function makeRequest(overrides: Partial<VisionRequest> = {}): VisionRequest {
  return {
    imagePath: '/tmp/test-screenshot.png',
    promptText: 'Describe this screenshot.',
    model: 'claude-haiku-test',
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('ClaudeCliVisionClient', () => {
  it('parses canned JSON response from fake-claude binary', async () => {
    const client = new ClaudeCliVisionClient(FAKE_CLAUDE, 'claude-haiku-test', 5000);
    const response = await client.classify(makeRequest());
    expect(response.rawText).toContain('FAKE_VISION_RESPONSE');
    expect(response.usage).toBeDefined();
    expect(response.usage?.inputTokens).toBe(100);
    expect(response.usage?.outputTokens).toBe(20);
  });

  it('throws VisionApiError("timeout") when subprocess exceeds timeoutMs', async () => {
    // Create a temporary script that sleeps forever
    const sleepScript = path.join(os.tmpdir(), 'bughunter-test-sleep.sh');
    fs.writeFileSync(sleepScript, '#!/bin/sh\nsleep 60\n');
    fs.chmodSync(sleepScript, '755');

    const client = new ClaudeCliVisionClient(sleepScript, 'claude-haiku-test', 100);
    await expect(client.classify(makeRequest())).rejects.toMatchObject({
      kind: 'timeout',
    });
    fs.rmSync(sleepScript, { force: true });
  });

  it('throws VisionApiError("transport") when binary exits non-zero', async () => {
    const client = new ClaudeCliVisionClient('/bin/false', 'claude-haiku-test', 5000);
    await expect(client.classify(makeRequest())).rejects.toMatchObject({
      kind: 'transport',
    });
  });

  it('throws VisionApiError("malformed") when stdout is not valid JSON', async () => {
    // Create a script that prints non-JSON and exits 0
    const badScript = path.join(os.tmpdir(), 'bughunter-test-badjson.sh');
    fs.writeFileSync(badScript, '#!/bin/sh\necho "not valid json at all"\n');
    fs.chmodSync(badScript, '755');

    const client = new ClaudeCliVisionClient(badScript, 'claude-haiku-test', 5000);
    await expect(client.classify(makeRequest())).rejects.toMatchObject({
      kind: 'malformed',
    });
    fs.rmSync(badScript, { force: true });
  });
});
