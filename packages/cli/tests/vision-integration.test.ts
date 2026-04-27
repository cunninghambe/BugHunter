// Integration test for visual anomaly classification pipeline (§ 10.5).
// Uses a stubbed VisionClient that maps screenshot SHA-256 → canned response.
// No real API calls; covers orchestration end-to-end.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { classifyVisualAnomalies } from '../src/classify/vision.js';
import type { VisionClientInterface, VisionRequest, VisionResponse } from '../src/adapters/vision-client.js';
import type { VisionConfig } from '../src/types.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BROKEN_FIXTURE = path.resolve(__dirname, '../../../fixtures/vision-broken-page/broken-layout.png');
const CLEAN_FIXTURE = path.resolve(__dirname, '../../../fixtures/vision-broken-page/clean-page.png');

function sha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Stub client: maps SHA-256 hash → canned rawText response.
function makeHashStub(map: Record<string, string>): VisionClientInterface {
  return {
    async classify(req: VisionRequest): Promise<VisionResponse> {
      const buf = fs.readFileSync(req.imagePath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const rawText = map[hash] ?? JSON.stringify({ anomalies: [] });
      return { rawText };
    },
  };
}

const BROKEN_RESPONSE = JSON.stringify({
  anomalies: [{
    severity: 'critical',
    category: 'layout',
    element: 'the entire main content area',
    description: 'The sidebar is rendered on top of the main content; trades table is fully obscured.',
    suggestedFix: 'Check sidebar z-index and the parent flex container.',
  }],
});

const CLEAN_RESPONSE = JSON.stringify({ anomalies: [] });

describe('vision integration — end-to-end with stub client', () => {
  it('broken-layout fixture produces a critical visual_anomaly detection', async () => {
    const hashMap = {
      [sha256(BROKEN_FIXTURE)]: BROKEN_RESPONSE,
      [sha256(CLEAN_FIXTURE)]: CLEAN_RESPONSE,
    };
    const client = makeHashStub(hashMap);

    const detections = await classifyVisualAnomalies({
      screenshotPath: BROKEN_FIXTURE,
      url: 'http://localhost:3000/dashboard',
      action: { kind: 'render' },
      role: 'owner',
      client,
    });

    expect(detections).toHaveLength(1);
    const d = detections[0]!;
    expect(d.kind).toBe('visual_anomaly');
    expect(d.visualSeverity).toBe('critical');
    expect(d.visualCategory).toBe('layout');
    expect(d.visualSuggestedFix).toContain('z-index');
    expect(d.screenshotPath).toBe(BROKEN_FIXTURE);
  });

  it('clean-page fixture produces zero detections', async () => {
    const hashMap = {
      [sha256(BROKEN_FIXTURE)]: BROKEN_RESPONSE,
      [sha256(CLEAN_FIXTURE)]: CLEAN_RESPONSE,
    };
    const client = makeHashStub(hashMap);

    const detections = await classifyVisualAnomalies({
      screenshotPath: CLEAN_FIXTURE,
      url: 'http://localhost:3000/about',
      action: { kind: 'navigate' },
      role: 'anonymous',
      client,
    });

    expect(detections).toHaveLength(0);
  });

  it('severity threshold filters out major when threshold=critical', async () => {
    const majorResponse = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'state', element: 'list', description: 'Empty list area' }],
    });
    const client = makeHashStub({ [sha256(BROKEN_FIXTURE)]: majorResponse });
    const config: VisionConfig = { severityThreshold: 'critical' };

    const detections = await classifyVisualAnomalies({
      screenshotPath: BROKEN_FIXTURE,
      url: 'http://localhost:3000/dashboard',
      action: { kind: 'click', selector: '#submit' },
      role: 'owner',
      config,
      client,
    });

    expect(detections).toHaveLength(0);
  });

  it('detection cap: 8-anomaly response → exactly 5 detections', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      severity: 'major',
      category: 'layout',
      element: `element-${i}`,
      description: `Issue number ${i}`,
    }));
    const manyResponse = JSON.stringify({ anomalies: items });
    const client = makeHashStub({ [sha256(BROKEN_FIXTURE)]: manyResponse });

    const detections = await classifyVisualAnomalies({
      screenshotPath: BROKEN_FIXTURE,
      url: 'http://localhost:3000/',
      action: { kind: 'render' },
      role: 'anonymous',
      client,
    });

    expect(detections).toHaveLength(5);
  });
});
