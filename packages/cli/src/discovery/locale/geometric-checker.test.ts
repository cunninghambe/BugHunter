// Tests for the pure geometric diff (§4.4).

import { describe, it, expect } from 'vitest';
import { checkGeometry } from './geometric-checker.js';
import type { DOMRectLite } from '../../types.js';

const VP = { w: 1280, h: 800 };

function rect(x: number, y: number, w: number, h: number): DOMRectLite {
  return { x, y, w, h };
}

describe('checkGeometry', () => {
  it('returns empty when variant matches ltr', () => {
    const rects = { '#btn': rect(100, 50, 120, 40) };
    expect(checkGeometry(rects, rects, VP)).toEqual([]);
  });

  it('detects parent_overflow when variant scrollWidth exceeds viewport + 16', () => {
    const ltr = { '__page__': rect(0, 0, 1280, 900) };
    const variant = { '__page__': rect(0, 0, 1350, 900) };
    const findings = checkGeometry(ltr, variant, VP);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('parent_overflow');
    expect(findings[0]?.certainty).toBe('high');
  });

  it('does not flag parent_overflow when ltr also overflows', () => {
    const ltr = { '__page__': rect(0, 0, 1350, 900) };
    const variant = { '__page__': rect(0, 0, 1400, 900) };
    expect(checkGeometry(ltr, variant, VP)).toEqual([]);
  });

  it('detects off_screen when element exits viewport in variant but not ltr', () => {
    const ltr = { '#nav': rect(10, 10, 200, 40) };
    const variant = { '#nav': rect(-300, 10, 200, 40) };
    const findings = checkGeometry(ltr, variant, VP);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('off_screen');
    expect(findings[0]?.certainty).toBe('high');
  });

  it('does not flag off_screen when element was already off screen in ltr', () => {
    const ltr = { '#nav': rect(-300, 10, 200, 40) };
    const variant = { '#nav': rect(-400, 10, 200, 40) };
    expect(checkGeometry(ltr, variant, VP)).toEqual([]);
  });

  it('detects clipped_text (ambiguous) when variant width grows by more than 2px', () => {
    const ltr = { '#label': rect(10, 10, 100, 20) };
    const variant = { '#label': rect(10, 10, 110, 20) };
    const findings = checkGeometry(ltr, variant, VP);
    const clipped = findings.filter(f => f.kind === 'clipped_text');
    expect(clipped).toHaveLength(1);
    expect(clipped[0]?.certainty).toBe('ambiguous');
  });

  it('does not flag clipped_text when width grows by 2px or less', () => {
    const ltr = { '#label': rect(10, 10, 100, 20) };
    const variant = { '#label': rect(10, 10, 102, 20) };
    const clipped = checkGeometry(ltr, variant, VP).filter(f => f.kind === 'clipped_text');
    expect(clipped).toHaveLength(0);
  });

  it('detects overlap_pair (high) when two large elements overlap only in variant', () => {
    const ltr = { '#a': rect(0, 0, 100, 50), '#b': rect(200, 0, 100, 50) };
    const variant = { '#a': rect(0, 0, 100, 50), '#b': rect(50, 0, 100, 50) };
    const findings = checkGeometry(ltr, variant, VP);
    const overlaps = findings.filter(f => f.kind === 'overlap_pair');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.certainty).toBe('high');
    expect(overlaps[0]?.selector).toBe('#a');
    expect(overlaps[0]?.pairSelector).toBe('#b');
  });

  it('marks overlap_pair as ambiguous when overlap depth ≤ 8px', () => {
    const ltr = { '#a': rect(0, 0, 100, 50), '#b': rect(200, 0, 100, 50) };
    const variant = { '#a': rect(0, 0, 100, 50), '#b': rect(96, 0, 100, 50) };
    const overlaps = checkGeometry(ltr, variant, VP).filter(f => f.kind === 'overlap_pair');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.certainty).toBe('ambiguous');
  });

  it('does not flag overlap_pair when elements already overlapped in ltr', () => {
    const ltr = { '#a': rect(0, 0, 100, 50), '#b': rect(50, 0, 100, 50) };
    const variant = { '#a': rect(0, 0, 100, 50), '#b': rect(50, 0, 100, 50) };
    const overlaps = checkGeometry(ltr, variant, VP).filter(f => f.kind === 'overlap_pair');
    expect(overlaps).toHaveLength(0);
  });

  it('skips __page__ selector when checking off_screen and clipped_text', () => {
    const ltr = { '__page__': rect(0, 0, 1280, 900) };
    const variant = { '__page__': rect(0, 0, 1280, 900) };
    expect(checkGeometry(ltr, variant, VP)).toEqual([]);
  });

  it('handles missing ltr entry for a new variant selector gracefully', () => {
    const ltr: Record<string, DOMRectLite> = {};
    const variant = { '#new': rect(10, 10, 100, 40) };
    const findings = checkGeometry(ltr, variant, VP);
    // element is on screen, no findings expected
    expect(findings.filter(f => f.kind !== 'parent_overflow')).toHaveLength(0);
  });
});
