// Mobile mode orchestrator (v0.41).
// applyMobileMode: sets UA + first-viewport; called once after browser-login.
// clearMobileMode: resets to desktop UA + 1280-wide viewport; called in cleanup.

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { MobileConfig, MobileViewport } from '../types.js';
import { uaForViewport } from '../static/mobile-ua.js';
import { log } from '../log.js';

// The iphone-14 viewport is required for the 100vh detector.
const REQUIRED_IPHONE14: MobileViewport = { width: 390, height: 844, label: 'iphone-14', platform: 'ios' };

export function resolvedMobileViewports(mobileConfig: MobileConfig): MobileViewport[] {
  const viewports = [...(mobileConfig.viewports ?? [])];
  const hasIphone14 = viewports.some(v => v.label === 'iphone-14');
  if (!hasIphone14) viewports.push(REQUIRED_IPHONE14);
  return viewports.sort((a, b) => a.width - b.width);
}

export function resolvedMobileUa(mobileConfig: MobileConfig): string {
  if (mobileConfig.userAgent !== undefined) return mobileConfig.userAgent;
  const first = resolvedMobileViewports(mobileConfig)[0];
  return uaForViewport(first.platform, undefined);
}

export async function applyMobileMode(
  browser: BrowserMcpAdapter,
  mobileConfig: MobileConfig,
): Promise<{ ok: true; ua: string } | { ok: false; reason: string }> {
  const ua = resolvedMobileUa(mobileConfig);

  if (browser.setUserAgent !== undefined) {
    const uaResult = await browser.setUserAgent(ua);
    if (!uaResult.ok) {
      log.warn(`mobile_partial_setup_aborted: setUserAgent failed (${uaResult.reason})`);
      return { ok: false, reason: `mobile_partial_setup_aborted: ${uaResult.reason}` };
    }
    log.info(`mobile-mode: UA set (${ua.slice(0, 60)}...)`);
  } else {
    log.warn('mobile-mode: setUserAgent not available; UA not changed');
  }

  // Set to the first (smallest) mobile viewport initially
  const viewports = resolvedMobileViewports(mobileConfig);
  const first = viewports[0];
  if (browser.setViewport !== undefined) {
    const vpResult = await browser.setViewport(first.width, first.height);
    if (!vpResult.ok) {
      log.warn(`mobile_partial_setup_aborted: setViewport failed (${vpResult.reason})`);
      return { ok: false, reason: `mobile_partial_setup_aborted: ${vpResult.reason}` };
    }
  }

  return { ok: true, ua };
}

export async function clearMobileMode(browser: BrowserMcpAdapter): Promise<void> {
  if (browser.setViewport !== undefined) {
    const result = await browser.setViewport(1280, 832);
    if (!result.ok) {
      log.warn(`mobile-mode clear: setViewport restore failed (${result.reason})`);
    }
  }
  // UA reset is best-effort; log only
  if (browser.setUserAgent !== undefined) {
    const result = await browser.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    );
    if (!result.ok) {
      log.warn(`mobile-mode clear: setUserAgent restore failed (${result.reason})`);
    }
  }
}
