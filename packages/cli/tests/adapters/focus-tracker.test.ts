import { describe, it, expect, vi } from 'vitest';
import { FocusTracker } from '../../src/adapters/focus-tracker.js';
import type { TabScope } from '../../src/adapters/browser-mcp.js';

function makeScope(activeTag: string | null): TabScope {
  return {
    tabId: 'test-tab',
    navigate: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    clickByHint: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ value: activeTag }),
  } as unknown as TabScope;
}

describe('FocusTracker', () => {
  it('returns lost:false when focus is on a real element (INPUT)', async () => {
    const scope = makeScope('INPUT');
    const tracker = new FocusTracker();
    const result = await tracker.observe(scope, 'button#submit');
    expect(result.lost).toBe(false);
    if (!result.lost) {
      expect(result.activeElementTag).toBe('INPUT');
    }
  });

  it('returns lost:true when focus is on BODY', async () => {
    const scope = makeScope('BODY');
    const tracker = new FocusTracker();
    const result = await tracker.observe(scope, 'button#close');
    expect(result.lost).toBe(true);
    if (result.lost) {
      expect(result.activeElementTag).toBe('BODY');
      expect(result.triggeringSelector).toBe('button#close');
    }
  });

  it('returns lost:true when activeElement is null', async () => {
    const scope = makeScope(null);
    const tracker = new FocusTracker();
    const result = await tracker.observe(scope, 'button#open-modal');
    expect(result.lost).toBe(true);
    if (result.lost) {
      expect(result.activeElementTag).toBeNull();
    }
  });

  it('returns lost:false when focus is on BUTTON', async () => {
    const scope = makeScope('BUTTON');
    const tracker = new FocusTracker();
    const result = await tracker.observe(scope, 'button#next');
    expect(result.lost).toBe(false);
  });
});
