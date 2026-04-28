import { describe, it, expect, vi } from 'vitest';
import { replayActionLog } from '../src/repro/replay.js';
import type { ActionLog } from '../src/repro/action-log.js';
import type { BrowserMcpAdapter } from '../src/adapters/browser-mcp.js';
import type { SurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';

function mockBrowser(): BrowserMcpAdapter {
  return {
    navigate: vi.fn().mockResolvedValue({ url: 'http://localhost:3000/test', title: 'Test' }),
    click: vi.fn().mockResolvedValue({ clicked: true }),
    type: vi.fn().mockResolvedValue({ typed: true }),
    scroll: vi.fn().mockResolvedValue({ scrolled: true }),
    snapshot: vi.fn().mockResolvedValue({ snapshot: '<html>ok</html>' }),
    screenshot: vi.fn().mockResolvedValue({ path: '/tmp/screenshot.png' }),
    evaluate: vi.fn().mockResolvedValue({ value: null }),
    listTabs: vi.fn().mockResolvedValue({ tabs: [] }),
    closeTab: vi.fn().mockResolvedValue({ closed: true }),
  };
}

function mockSurface(): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn().mockResolvedValue({ ok: true, status: 200, durationMs: 10, revisionAtCall: 1 }),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
  };
}

describe('replay', () => {
  it('re-executes navigate + click action log', async () => {
    const browser = mockBrowser();
    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-1',
      runId: 'run-1',
      role: 'owner',
      page: '/products',
      baseUrl: 'http://localhost:3000/products',
      actions: [
        {
          step: 0,
          kind: 'navigate',
          url: 'http://localhost:3000/products',
          timestamp: new Date().toISOString(),
        },
        {
          step: 1,
          kind: 'click',
          selector: 'button[data-testid="edit"]',
          timestamp: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-1');

    expect(result.ok).toBe(true);
    expect(browser.navigate).toHaveBeenCalledWith('http://localhost:3000/products', { 'X-BugHunter-Run': 'run-1' });
    expect(browser.click).toHaveBeenCalledWith('button[data-testid="edit"]');
  });

  it('re-executes api_call action log via surface_call', async () => {
    const browser = mockBrowser();
    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-2',
      runId: 'run-1',
      role: 'owner',
      page: '/api/products',
      baseUrl: '/api/products',
      actions: [
        {
          step: 0,
          kind: 'api_call',
          toolId: 'tool-abc',
          input: { name: 'test' },
          palette: 'happy',
          role: 'owner',
          timestamp: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-1');

    expect(result.ok).toBe(true);
    expect(surface.surface_call).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'tool-abc', role: 'owner', noAutoRelogin: false })
    );
  });

  it('returns ok:false when a step throws', async () => {
    const browser = mockBrowser();
    (browser.click as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Element not found'));

    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-3',
      runId: 'run-1',
      role: 'owner',
      page: '/test',
      baseUrl: '/test',
      actions: [
        {
          step: 0,
          kind: 'click',
          selector: '#missing-button',
          timestamp: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Element not found');
  });

  // B-4 regression: empty selector must throw, not silently succeed (no-op = false positive).
  it('B-4: click with empty selector throws instead of silently no-oping', async () => {
    const browser = mockBrowser();
    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-b4-click',
      runId: 'run-b4',
      role: 'owner',
      page: '/test',
      baseUrl: '/test',
      actions: [
        { step: 0, kind: 'click', selector: '', timestamp: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-b4');
    // Empty selector must produce ok:false — the click never executed.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty selector');
    // browser.click must NOT have been called.
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('B-4: fill with empty selector throws instead of silently no-oping', async () => {
    const browser = mockBrowser();
    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-b4-fill',
      runId: 'run-b4',
      role: 'owner',
      page: '/test',
      baseUrl: '/test',
      actions: [
        { step: 0, kind: 'fill', selector: '', value: 'test', timestamp: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-b4');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty selector');
  });

  it('B-4: submit with empty selector throws instead of silently no-oping', async () => {
    const browser = mockBrowser();
    const surface = mockSurface();

    const actionLog: ActionLog = {
      occurrenceId: 'occ-b4-submit',
      runId: 'run-b4',
      role: 'owner',
      page: '/test',
      baseUrl: '/test',
      actions: [
        { step: 0, kind: 'submit', selector: '', timestamp: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
    };

    const result = await replayActionLog(actionLog, browser, surface, 'run-b4');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty selector');
  });
});
