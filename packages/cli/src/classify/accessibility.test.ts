// Unit tests for classifyA11yDelta (V24, spec §3.5, acceptance criterion 4).

import { describe, it, expect } from 'vitest';
import { classifyA11yDelta, getAxeScript, AXE_RUN_SCRIPT_MOBILE, AXE_RUN_SCRIPT } from './accessibility.js';
import type { A11yViolation } from './accessibility.js';

function makeViolation(id: string, impact: A11yViolation['impact']): A11yViolation {
  return { id, impact, description: `${id} violation`, nodes: [] };
}

describe('getAxeScript (#152)', () => {
  it('returns AXE_RUN_SCRIPT_MOBILE when mobile=true', () => {
    expect(getAxeScript(true)).toBe(AXE_RUN_SCRIPT_MOBILE);
  });

  it('returns AXE_RUN_SCRIPT when mobile=false', () => {
    expect(getAxeScript(false)).toBe(AXE_RUN_SCRIPT);
  });

  it('mobile script enables target-size rule', () => {
    expect(getAxeScript(true)).toContain('target-size');
  });

  it('desktop script does not include target-size rule', () => {
    expect(getAxeScript(false)).not.toContain('target-size');
  });
});

describe('classifyA11yDelta', () => {
  it('returns zero detections when pre and post are identical', () => {
    const v = [makeViolation('aria-name', 'critical')];
    const result = classifyA11yDelta(v, v, '/page');
    expect(result).toHaveLength(0);
  });

  it('emits accessibility_critical for a new critical violation in post', () => {
    const pre: A11yViolation[] = [];
    const post = [makeViolation('aria-name', 'critical')];
    const result = classifyA11yDelta(pre, post, '/action-page');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('accessibility_critical');
    expect(result[0].pageRoute).toBe('/action-page');
    expect(result[0].selectorClass).toBe('aria-name');
    expect(result[0].rootCause).toContain('aria-name');
  });

  it('emits accessibility_critical for a new serious violation in post', () => {
    const pre: A11yViolation[] = [];
    const post = [makeViolation('color-contrast', 'serious')];
    const result = classifyA11yDelta(pre, post, '/page');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('accessibility_critical');
  });

  it('returns zero detections for a new minor violation in post (filtered out)', () => {
    const pre: A11yViolation[] = [];
    const post = [makeViolation('minor-thing', 'minor')];
    const result = classifyA11yDelta(pre, post, '/page');
    expect(result).toHaveLength(0);
  });

  it('returns zero detections for a new moderate violation in post (filtered out)', () => {
    const pre: A11yViolation[] = [];
    const post = [makeViolation('moderate-thing', 'moderate')];
    const result = classifyA11yDelta(pre, post, '/page');
    expect(result).toHaveLength(0);
  });

  it('emits only NEW violations (pre violations present in post are not counted)', () => {
    const pre = [makeViolation('aria-name', 'critical')];
    const post = [
      makeViolation('aria-name', 'critical'),
      makeViolation('button-name', 'serious'),
    ];
    const result = classifyA11yDelta(pre, post, '/page');
    expect(result).toHaveLength(1);
    expect(result[0].selectorClass).toBe('button-name');
  });

  it('handles empty pre and post without error', () => {
    expect(classifyA11yDelta([], [], '/page')).toHaveLength(0);
  });
});
