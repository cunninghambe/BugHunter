import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';
import { classifyVisualAnomalies } from '../src/classify/vision.js';
import { VisionApiError } from '../src/adapters/vision-client.js';
import type { VisionClientInterface, VisionRequest, VisionResponse } from '../src/adapters/vision-client.js';
import type { VisionConfig } from '../src/types.js';
import { log } from '../src/log.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BROKEN_FIXTURE = path.resolve(__dirname, '../../../fixtures/vision-broken-page/broken-layout.png');

function makeStub(rawText: string): VisionClientInterface {
  return { async classify(_req: VisionRequest): Promise<VisionResponse> { return { rawText }; } };
}

function makeThrowingStub(err: Error): VisionClientInterface {
  return { async classify(_req: VisionRequest): Promise<VisionResponse> { throw err; } };
}

const BASE_INPUT = {
  screenshotPath: BROKEN_FIXTURE,
  url: 'http://localhost:3000/dashboard',
  action: { kind: 'render' as const },
  role: 'owner',
};

describe('classifyVisualAnomalies', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('case 1: valid critical layout anomaly → one BugDetection with correct fields', async () => {
    const raw = JSON.stringify({
      anomalies: [{
        severity: 'critical',
        category: 'layout',
        element: 'the trade-list table',
        description: 'Broken sidebar obscures main content',
      }],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    const d = detections[0]!;
    expect(d.kind).toBe('visual_anomaly');
    expect(d.visualCategory).toBe('layout');
    expect(d.visualSeverity).toBe('critical');
    expect(d.rootCause).toContain('Broken sidebar obscures main content');
  });

  it('case 2: empty anomalies array → empty result', async () => {
    const raw = JSON.stringify({ anomalies: [] });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(0);
  });

  it('case 3: malformed JSON → empty result + log.warn called', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub('this is not json {trailing}') });
    expect(detections).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('case 4: JSON wrapped in markdown fences → strips fences and parses', async () => {
    const inner = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'state', element: 'main area', description: 'Blank content' }],
    });
    const raw = '```json\n' + inner + '\n```';
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.visualCategory).toBe('state');
  });

  it('case 5: client throws VisionApiError(timeout) → empty result + log.warn called', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const err = new VisionApiError('timeout', 'timed out');
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeThrowingStub(err) });
    expect(detections).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('case 6: 8 anomalies → result has exactly 5; log.info truncated', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const items = Array.from({ length: 8 }, (_, i) => ({
      severity: 'major',
      category: 'layout',
      element: `element-${i}`,
      description: `Issue ${i}`,
    }));
    const raw = JSON.stringify({ anomalies: items });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(5);
    const truncCalls = infoSpy.mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('truncated'));
    expect(truncCalls).toHaveLength(1);
    expect(truncCalls[0]![1]).toMatchObject({ kept: 5, dropped: 3 });
  });

  it('case 7: one minor, one major; default threshold (major) → only major returned', async () => {
    const raw = JSON.stringify({
      anomalies: [
        { severity: 'minor', category: 'a11y', element: 'button', description: 'Slight contrast issue' },
        { severity: 'major', category: 'state', element: 'list', description: 'Empty list' },
      ],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.visualSeverity).toBe('major');
  });

  it('case 8: critical anomaly with threshold=critical → result includes it', async () => {
    const config: VisionConfig = { severityThreshold: 'critical' };
    const raw = JSON.stringify({
      anomalies: [{ severity: 'critical', category: 'error', element: 'page', description: 'Whole page broken' }],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, config, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.visualSeverity).toBe('critical');
  });

  it('case 9: invalid severity "showstopper" → detection dropped; others kept', async () => {
    const raw = JSON.stringify({
      anomalies: [
        { severity: 'showstopper', category: 'layout', element: 'header', description: 'Bad' },
        { severity: 'major', category: 'content', element: 'title', description: 'Template string leak' },
      ],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.visualCategory).toBe('content');
  });

  it('case 10: invalid category "foo" → detection kept with visualCategory=other', async () => {
    const raw = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'foo', element: 'header', description: 'Something odd' }],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.visualCategory).toBe('other');
  });

  it('case 11: description > 500 chars → truncated to 500 in rootCause', async () => {
    const long = 'x'.repeat(600);
    const raw = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'layout', element: 'div', description: long }],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections).toHaveLength(1);
    // rootCause is "element: description" — the description portion should be truncated
    expect(detections[0]!.rootCause.length).toBeLessThanOrEqual(505 + 10); // element prefix + colon/space
    // Description portion itself ≤ 500
    const desc = detections[0]!.rootCause.replace(/^div: /, '');
    expect(desc.length).toBeLessThanOrEqual(500);
  });

  it('case 12: screenshotPath populated correctly in returned detection', async () => {
    const raw = JSON.stringify({
      anomalies: [{ severity: 'major', category: 'layout', element: 'div', description: 'Overlap' }],
    });
    const detections = await classifyVisualAnomalies({ ...BASE_INPUT, client: makeStub(raw) });
    expect(detections[0]!.screenshotPath).toBe(BROKEN_FIXTURE);
  });
});
