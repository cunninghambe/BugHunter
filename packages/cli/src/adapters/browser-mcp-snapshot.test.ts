// Unit tests for browser-mcp-snapshot — pure functions, no mocks needed.
import { describe, it, expect } from 'vitest';
import {
  parsePlaywrightHasText,
  parseSnapshot,
  resolveSelectorInSnapshot,
  resolveByHtml,
} from './browser-mcp-snapshot.js';
import type { SnapshotNode } from './browser-mcp-snapshot.js';

// ---------------------------------------------------------------------------
// Shared snapshot fixture: three buttons + one link
// ---------------------------------------------------------------------------
const SNAPSHOT_TEXT = [
  '- button "Log In" [ref=e1]',
  '- button "Sign Up" [ref=e2]',
  '- button "Help" [ref=e3]',
  '- link "Dashboard" [ref=e4]',
].join('\n');

function makeNodes(): SnapshotNode[] {
  return parseSnapshot(SNAPSHOT_TEXT);
}

// ---------------------------------------------------------------------------
// parsePlaywrightHasText
// ---------------------------------------------------------------------------
describe('parsePlaywrightHasText', () => {
  it('parses double-quoted form', () => {
    expect(parsePlaywrightHasText('button:has-text("log in")')).toEqual({ tag: 'button', text: 'log in' });
  });

  it('parses single-quoted form', () => {
    expect(parsePlaywrightHasText("button:has-text('log in')")).toEqual({ tag: 'button', text: 'log in' });
  });

  it('returns null for plain tag', () => {
    expect(parsePlaywrightHasText('button')).toBeNull();
  });

  it('returns null for #id selector', () => {
    expect(parsePlaywrightHasText('#submit')).toBeNull();
  });

  it('returns null for tag[attr=val]', () => {
    expect(parsePlaywrightHasText('button[type="submit"]')).toBeNull();
  });

  it('returns null for malformed has-text (no quotes)', () => {
    expect(parsePlaywrightHasText('button:has-text(log in)')).toBeNull();
  });

  it('returns null for non-tag prefix (missing tag)', () => {
    expect(parsePlaywrightHasText(':has-text("log in")')).toBeNull();
  });

  it('preserves text case', () => {
    const result = parsePlaywrightHasText('button:has-text("Log In")');
    expect(result).toEqual({ tag: 'button', text: 'Log In' });
  });

  it('handles a longer tag like "input"', () => {
    expect(parsePlaywrightHasText('input:has-text("submit")')).toEqual({ tag: 'input', text: 'submit' });
  });
});

// ---------------------------------------------------------------------------
// resolveSelectorInSnapshot — :has-text() branch
// ---------------------------------------------------------------------------
describe('resolveSelectorInSnapshot — :has-text()', () => {
  it('matches button by accessible name (case-insensitive substring)', () => {
    const nodes = makeNodes();
    // 'log in' matches 'Log In' case-insensitively
    expect(resolveSelectorInSnapshot('button:has-text("log in")', nodes)).toBe('e1');
  });

  it('matches with exact-case text too', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot('button:has-text("Log In")', nodes)).toBe('e1');
  });

  it('matches second button by name substring', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot('button:has-text("Sign")', nodes)).toBe('e2');
  });

  it('returns null when no role match', () => {
    const nodes = makeNodes();
    // no 'input' role in fixture
    expect(resolveSelectorInSnapshot('input:has-text("log in")', nodes)).toBeNull();
  });

  it('returns null when role matches but name does not', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot('button:has-text("nonexistent")', nodes)).toBeNull();
  });

  it('handles single-quoted :has-text()', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot("button:has-text('Help')", nodes)).toBe('e3');
  });
});

// ---------------------------------------------------------------------------
// Regression guard: existing selector forms still work
// ---------------------------------------------------------------------------
describe('resolveSelectorInSnapshot — existing selector forms (regression guard)', () => {
  it('eN ref returns itself', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot('e1', nodes)).toBe('e1');
  });

  it('structured selector matches by role+name', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot({ role: 'button', name: 'Help' }, nodes)).toBe('e3');
  });

  it('#id selector returns null when no id attr (falls through to evaluate)', () => {
    const nodes = makeNodes();
    // fixture nodes have no id attr
    expect(resolveSelectorInSnapshot('#missing', nodes)).toBeNull();
  });

  it('plain tag returns first matching role', () => {
    // add a node with id attr to test
    const nodes = parseSnapshot('- button "First" [ref=e10]\n- link "Second" [ref=e11]');
    expect(resolveSelectorInSnapshot('button', nodes)).toBe('e10');
  });

  it('tag[attr="value"] matches node with matching attr', () => {
    const snapshot = '- button "Submit" [ref=e20][type=submit]';
    const nodes = parseSnapshot(snapshot);
    expect(resolveSelectorInSnapshot('button[type="submit"]', nodes)).toBe('e20');
  });

  it('.class selector returns null (signals evaluate fallback)', () => {
    const nodes = makeNodes();
    expect(resolveSelectorInSnapshot('.btn-primary', nodes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------
describe('parseSnapshot', () => {
  it('parses ref= form', () => {
    const nodes = parseSnapshot('- button "Click Me" [ref=e5]');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ ref: 'e5', role: 'button', name: 'Click Me' });
  });

  it('skips lines without ref', () => {
    const nodes = parseSnapshot('- button "No Ref"\n- link "Has Ref" [ref=e6]');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.ref).toBe('e6');
  });

  it('extracts attrs from snapshot line', () => {
    const nodes = parseSnapshot('- input [ref=e7][type=text][id=email]');
    expect(nodes[0]?.attrs['type']).toBe('text');
    expect(nodes[0]?.attrs['id']).toBe('email');
  });

  it('returns empty array for empty string', () => {
    expect(parseSnapshot('')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveByHtml
// ---------------------------------------------------------------------------
describe('resolveByHtml', () => {
  it('matches node by aria-label in html', () => {
    const nodes = parseSnapshot('- button "Submit Form" [ref=e30]');
    const html = '<button aria-label="Submit Form" type="submit"></button>';
    expect(resolveByHtml(html, 'button', nodes)).toBe('e30');
  });

  it('matches node by text content', () => {
    const nodes = parseSnapshot('- button "Help" [ref=e31]');
    const html = '<button>Help</button>';
    expect(resolveByHtml(html, 'button', nodes)).toBe('e31');
  });

  it('returns null when no candidate matches', () => {
    const nodes = parseSnapshot('- button "Other" [ref=e32]');
    const html = '<button aria-label="Completely Different"></button>';
    expect(resolveByHtml(html, 'button', nodes)).toBeNull();
  });
});
