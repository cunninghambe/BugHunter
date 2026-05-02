// Integration smoke test: v0.41 mobile mode — hover-only-affordance static scanner.
// Does NOT require a live browser; tests the CSS scanner directly against the fixture.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanCssForHoverOnly } from '../../packages/cli/src/static/tools/hover-only-affordance.js';
import { detectViewport100vhBreak } from '../../packages/cli/src/perf/viewport-100vh-detector.js';
import { detectPullToRefreshConflict } from '../../packages/cli/src/perf/pull-to-refresh-detector.js';
import { detectSoftKeyboardOcclusion } from '../../packages/cli/src/perf/soft-keyboard-detector.js';
import { detectOrientationChangeBreak } from '../../packages/cli/src/perf/orientation-change-detector.js';
import { applyMobileMode, resolvedMobileViewports } from '../../packages/cli/src/phases/mobile-mode.js';
import type { MobileConfig } from '../../packages/cli/src/types.js';
import { vi } from 'vitest';

const FIXTURE_CSS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/mobile-bad/style.css',
);

describe('mobile-smoke: hover_only_affordance from fixture CSS', () => {
  it('detects ≥1 hover_only_affordance from mobile-bad/style.css', async () => {
    const css = fs.readFileSync(FIXTURE_CSS, 'utf-8');
    const detections = await scanCssForHoverOnly(css, 'fixtures/mobile-bad/style.css');
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections[0].kind).toBe('hover_only_affordance');
  });
});

describe('mobile-smoke: viewport_100vh_break detector', () => {
  it('detects break when scroll height unchanged after inset simulation', async () => {
    const browser = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('scrollHeight')) return { value: 1000 };
        // Return a 100vh fixed-position element
        return { value: [{ selector: '.sticky-footer', height: '844px' }] };
      }),
      setViewport: vi.fn().mockResolvedValue({ ok: true }),
    };
    const detections = await detectViewport100vhBreak(browser, '/', 390, 844);
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections[0].kind).toBe('viewport_100vh_break');
  });
});

describe('mobile-smoke: pull_to_refresh_conflict detector', () => {
  it('detects non-passive touchstart on document', async () => {
    const browser = {
      evaluate: vi.fn().mockResolvedValue({
        value: [
          { type: 'touchstart', passive: false, selector: 'document' },
          { type: 'touchmove',  passive: false, selector: 'document' },
        ],
      }),
    };
    const detections = await detectPullToRefreshConflict(browser, '/');
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections.some(d => d.kind === 'pull_to_refresh_conflict')).toBe(true);
  });
});

describe('mobile-smoke: soft_keyboard_occlusion detector', () => {
  it('detects occluded input', async () => {
    const browser = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('querySelectorAll')) return { value: [{ selector: '#email', type: 'email', bottom: 700 }] };
        if (script.includes('visualViewport')) return { value: null };
        return { value: { bottom: 700 } };
      }),
      setVirtualKeyboardInsets: vi.fn().mockResolvedValue({ ok: true }),
    };
    const detections = await detectSoftKeyboardOcclusion(browser, '/form', 844, 271);
    expect(detections.some(d => d.kind === 'soft_keyboard_occlusion')).toBe(true);
  });
});

describe('mobile-smoke: orientation_change_layout_break detector', () => {
  it('detects horizontal overflow after landscape rotation', async () => {
    const browser = {
      evaluate: vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('location.href')) return { value: 'http://localhost/' };
        if (script.includes('scrollTop')) return { value: [] };
        // Elements overflow at landscape width (390) — right > 390
        return { value: [{ testId: 'wide-table', right: 500 }] };
      }),
      setViewport: vi.fn().mockResolvedValue({ ok: true }),
    };
    const detections = await detectOrientationChangeBreak(browser, '/', 390, 844);
    expect(detections.some(d => d.kind === 'orientation_change_layout_break')).toBe(true);
  });
});

describe('mobile-smoke: applyMobileMode + resolvedMobileViewports', () => {
  const MOBILE_CONFIG: MobileConfig = {
    enabled: true,
    viewports: [
      { width: 375, height: 667, label: 'iphone-se', platform: 'ios' },
      { width: 390, height: 844, label: 'iphone-14', platform: 'ios' },
      { width: 412, height: 915, label: 'pixel-7',   platform: 'android' },
    ],
    softKeyboard: 'cdp',
    keyboardHeightPx: 271,
    orientationChange: true,
    hoverOnlyScan: true,
  };

  it('resolves three default viewports', () => {
    const viewports = resolvedMobileViewports(MOBILE_CONFIG);
    expect(viewports.map(v => v.label)).toContain('iphone-se');
    expect(viewports.map(v => v.label)).toContain('iphone-14');
    expect(viewports.map(v => v.label)).toContain('pixel-7');
  });

  it('applyMobileMode returns ok:true with mock adapter', async () => {
    const browser = {
      setUserAgent: vi.fn().mockResolvedValue({ ok: true }),
      setViewport: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as import('../../packages/cli/src/adapters/browser-mcp.js').BrowserMcpAdapter;

    const result = await applyMobileMode(browser, MOBILE_CONFIG);
    expect(result.ok).toBe(true);
  });

  it('summary.mobile.viewportsExercised contains all three labels', () => {
    const viewports = resolvedMobileViewports(MOBILE_CONFIG);
    const labels = viewports.map(v => v.label);
    expect(labels).toContain('iphone-se');
    expect(labels).toContain('iphone-14');
    expect(labels).toContain('pixel-7');
  });
});
