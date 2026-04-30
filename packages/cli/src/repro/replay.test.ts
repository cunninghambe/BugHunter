// Unit tests for resolveActionLogUrl and URL-resolution in replayActionLog.

import { describe, it, expect, vi } from 'vitest';
import { resolveActionLogUrl, replayActionLog } from './replay.js';
import type { ActionLog } from './action-log.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

// --- resolveActionLogUrl unit tests (§3.3 cases) ---

describe('resolveActionLogUrl', () => {
  it('passes through an absolute HTTP URL unchanged', () => {
    const result = resolveActionLogUrl('http://localhost:3010/dashboard', 'http://localhost:3010');
    expect(result).toBe('http://localhost:3010/dashboard');
  });

  it('resolves a relative path against appBaseUrl', () => {
    const result = resolveActionLogUrl('/login', 'http://localhost:3010');
    expect(result).toBe('http://localhost:3010/login');
  });

  it('resolves root path "/" against appBaseUrl', () => {
    const result = resolveActionLogUrl('/', 'http://localhost:3010');
    expect(result).toBe('http://localhost:3010/');
  });

  it('returns null for relative URL when appBaseUrl is absent', () => {
    const result = resolveActionLogUrl('/', undefined);
    expect(result).toBeNull();
  });

  it('returns null for relative URL when appBaseUrl is empty string', () => {
    const result = resolveActionLogUrl('/', '');
    expect(result).toBeNull();
  });

  it('returns null for a garbage URL with no appBaseUrl', () => {
    const result = resolveActionLogUrl('not-a-url-at-all', undefined);
    expect(result).toBeNull();
  });

  it('resolves a garbage relative token against appBaseUrl', () => {
    // "not-a-url-at-all" is treated as a relative path by the URL constructor
    const result = resolveActionLogUrl('not-a-url-at-all', 'http://localhost:3010');
    expect(result).toBe('http://localhost:3010/not-a-url-at-all');
  });

  it('rejects javascript: protocol absolute URLs', () => {
    const result = resolveActionLogUrl('javascript:void(0)', 'http://localhost:3010');
    expect(result).toBeNull();
  });

  it('honors absolute URL on a different host than appBaseUrl (EC-3)', () => {
    const result = resolveActionLogUrl('http://other-host:9999/path', 'http://localhost:3010');
    expect(result).toBe('http://other-host:9999/path');
  });

  it('handles no-trailing-slash appBaseUrl with path correctly (EC-4)', () => {
    const result = resolveActionLogUrl('/dashboard', 'http://localhost:3010');
    expect(result).toBe('http://localhost:3010/dashboard');
  });
});

// --- replayActionLog integration: navigate step URL resolution ---

function makeActionLog(url: string): ActionLog {
  return {
    occurrenceId: 'occ-1',
    runId: 'run-1',
    role: 'user',
    page: url,
    baseUrl: url,
    actions: [{ step: 0, kind: 'navigate', url, timestamp: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
  };
}

function makeBrowser(navigateMock: ReturnType<typeof vi.fn>): BrowserMcpAdapter {
  return {
    navigate: navigateMock,
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html/>' }),
    clickByHint: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    withTab: vi.fn(),
  } as unknown as BrowserMcpAdapter;
}

function makeSurface(): SurfaceMcpAdapter {
  return { surface_call: vi.fn() } as unknown as SurfaceMcpAdapter;
}

describe('replayActionLog — navigate URL resolution', () => {
  it('calls browser.navigate with the same absolute URL (passthrough)', async () => {
    const navigateMock = vi.fn().mockResolvedValue({ url: 'http://localhost:3010/', title: '' });
    const browser = makeBrowser(navigateMock);

    await replayActionLog(
      makeActionLog('http://localhost:3010/'),
      browser,
      makeSurface(),
      'run-1',
      'http://localhost:3010',
    );

    expect(navigateMock).toHaveBeenCalledWith('http://localhost:3010/', expect.any(Object));
  });

  it('resolves relative /login against appBaseUrl before calling navigate', async () => {
    const navigateMock = vi.fn().mockResolvedValue({ url: 'http://localhost:3010/login', title: '' });
    const browser = makeBrowser(navigateMock);

    await replayActionLog(
      makeActionLog('/login'),
      browser,
      makeSurface(),
      'run-1',
      'http://localhost:3010',
    );

    expect(navigateMock).toHaveBeenCalledWith('http://localhost:3010/login', expect.any(Object));
  });

  it('resolves root path "/" against appBaseUrl', async () => {
    const navigateMock = vi.fn().mockResolvedValue({ url: 'http://localhost:3010/', title: '' });
    const browser = makeBrowser(navigateMock);

    await replayActionLog(
      makeActionLog('/'),
      browser,
      makeSurface(),
      'run-1',
      'http://localhost:3010',
    );

    expect(navigateMock).toHaveBeenCalledWith('http://localhost:3010/', expect.any(Object));
  });

  it('returns passed:false with replay_url_unresolvable error when appBaseUrl is absent', async () => {
    const navigateMock = vi.fn();
    const browser = makeBrowser(navigateMock);

    const result = await replayActionLog(
      makeActionLog('/'),
      browser,
      makeSurface(),
      'run-1',
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/replay_url_unresolvable/);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('returns passed:false with replay_url_unresolvable error for javascript: URL', async () => {
    const navigateMock = vi.fn();
    const browser = makeBrowser(navigateMock);

    const result = await replayActionLog(
      makeActionLog('javascript:void(0)'),
      browser,
      makeSurface(),
      'run-1',
      'http://localhost:3010',
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/replay_url_unresolvable/);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
