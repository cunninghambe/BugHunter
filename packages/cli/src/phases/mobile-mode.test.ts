import { describe, it, expect, vi } from 'vitest';
import { applyMobileMode, clearMobileMode, resolvedMobileViewports, resolvedMobileUa } from './mobile-mode.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { MobileConfig } from '../types.js';
import { MOBILE_USER_AGENTS } from '../static/mobile-ua.js';

const DEFAULT_MOBILE_CONFIG: MobileConfig = {
  enabled: true,
  viewports: [
    { width: 375, height: 667, label: 'iphone-se', platform: 'ios' },
    { width: 390, height: 844, label: 'iphone-14', platform: 'ios' },
    { width: 412, height: 915, label: 'pixel-7', platform: 'android' },
  ],
  softKeyboard: 'cdp',
  keyboardHeightPx: 271,
  orientationChange: true,
  hoverOnlyScan: true,
};

function makeBrowser(opts: {
  setUserAgentResult?: { ok: true } | { ok: false; reason: string };
  setViewportResult?: { ok: true } | { ok: false; reason: string };
} = {}): BrowserMcpAdapter {
  const setUserAgent = vi.fn().mockResolvedValue(opts.setUserAgentResult ?? { ok: true });
  const setViewport = vi.fn().mockResolvedValue(opts.setViewportResult ?? { ok: true });
  return { setUserAgent, setViewport } as unknown as BrowserMcpAdapter;
}

describe('resolvedMobileViewports', () => {
  it('returns viewports sorted by width', () => {
    const result = resolvedMobileViewports(DEFAULT_MOBILE_CONFIG);
    const widths = result.map(v => v.width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('injects iphone-14 when missing', () => {
    const config: MobileConfig = { ...DEFAULT_MOBILE_CONFIG, viewports: [{ width: 375, height: 667, label: 'iphone-se', platform: 'ios' }] };
    const result = resolvedMobileViewports(config);
    expect(result.some(v => v.label === 'iphone-14')).toBe(true);
  });

  it('does not duplicate iphone-14 when already present', () => {
    const result = resolvedMobileViewports(DEFAULT_MOBILE_CONFIG);
    expect(result.filter(v => v.label === 'iphone-14')).toHaveLength(1);
  });
});

describe('resolvedMobileUa', () => {
  it('returns override when userAgent is set', () => {
    const config: MobileConfig = { ...DEFAULT_MOBILE_CONFIG, userAgent: 'CustomUA/1.0' };
    expect(resolvedMobileUa(config)).toBe('CustomUA/1.0');
  });

  it('returns ios UA for ios platform', () => {
    expect(resolvedMobileUa(DEFAULT_MOBILE_CONFIG)).toBe(MOBILE_USER_AGENTS.ios);
  });
});

describe('applyMobileMode', () => {
  it('returns ok:true and sets UA + viewport', async () => {
    const browser = makeBrowser();
    const result = await applyMobileMode(browser, DEFAULT_MOBILE_CONFIG);
    expect(result.ok).toBe(true);
    expect((browser.setUserAgent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((browser.setViewport as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns ok:false when setUserAgent fails', async () => {
    const browser = makeBrowser({ setUserAgentResult: { ok: false, reason: 'ua_not_supported' } });
    const result = await applyMobileMode(browser, DEFAULT_MOBILE_CONFIG);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when setViewport fails', async () => {
    const browser = makeBrowser({ setViewportResult: { ok: false, reason: 'viewport_fail' } });
    const result = await applyMobileMode(browser, DEFAULT_MOBILE_CONFIG);
    expect(result.ok).toBe(false);
  });

  it('succeeds without setUserAgent if method is absent', async () => {
    const setViewport = vi.fn().mockResolvedValue({ ok: true });
    const browser = { setViewport } as unknown as BrowserMcpAdapter;
    const result = await applyMobileMode(browser, DEFAULT_MOBILE_CONFIG);
    expect(result.ok).toBe(true);
  });

  it('cookies are preserved across UA change (UA change does not clear context)', async () => {
    // This is a documentation test: applyMobileMode runs AFTER browser-login
    // so the cookie jar is already populated. We just verify the call order invariant.
    const browser = makeBrowser();
    const result = await applyMobileMode(browser, DEFAULT_MOBILE_CONFIG);
    expect(result.ok).toBe(true);
    // setUserAgent is the first call (UA before viewport)
    expect((browser.setUserAgent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((browser.setViewport as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });
});

describe('clearMobileMode', () => {
  it('resets viewport to 1280', async () => {
    const browser = makeBrowser();
    await clearMobileMode(browser);
    const calls = (browser.setViewport as ReturnType<typeof vi.fn>).mock.calls as [number, number][];
    expect(calls[0][0]).toBe(1280);
  });
});
