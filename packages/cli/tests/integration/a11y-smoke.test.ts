/**
 * Integration smoke test: a11y baseline classifier produces all 5 a11y BugKinds.
 * These tests use mock axe violation data that mirrors what the synthetic fixtures
 * (fixtures/a11y-bad/*) would produce when loaded in a real browser with axe-core injected.
 */
import { describe, it, expect } from 'vitest';
import { classifyA11yBaseline } from '../../src/classify/a11y-baseline.js';
import type { A11yViolation, KeyboardTrapResult, FocusAfterActionResult } from '../../src/classify/a11y-baseline.js';
import type { BugKind } from '../../src/types.js';

const ALL_A11Y_KINDS: BugKind[] = [
  'axe_color_contrast_strong',
  'keyboard_trap',
  'focus_lost_after_action',
  'image_missing_alt',
  'form_input_unlabeled',
];

function makeNode(target: string): unknown {
  return { target: [target], html: '' };
}

describe('a11y-smoke: all 5 a11y BugKinds emitted', () => {
  it('emits axe_color_contrast_strong from fixtures/a11y-bad/contrast', () => {
    // Mirrors axe output on fixtures/a11y-bad/contrast/index.html
    const violations: A11yViolation[] = [{
      id: 'color-contrast',
      impact: 'serious',
      description: 'Elements must have sufficient color contrast',
      nodes: [makeNode('.muted-text'), makeNode('.stat-card')],
    }];
    const detections = classifyA11yBaseline({ pageRoute: '/contrast', axeViolations: violations });
    expect(detections.some(d => d.kind === 'axe_color_contrast_strong')).toBe(true);
  });

  it('emits keyboard_trap from fixtures/a11y-bad/trap', () => {
    const trap: KeyboardTrapResult = {
      trapped: true,
      selectorClass: 'INPUT#trap-input',
      pressCount: 20,
      observedFocusChain: Array(20).fill('INPUT#trap-input'),
    };
    const detections = classifyA11yBaseline({ pageRoute: '/trap', axeViolations: [], keyboardTrap: trap });
    expect(detections.some(d => d.kind === 'keyboard_trap')).toBe(true);
  });

  it('emits focus_lost_after_action from fixtures/a11y-bad/focus-lost', () => {
    const focus: FocusAfterActionResult = {
      lost: true,
      activeElementTag: 'BODY',
      triggeringSelector: 'button#focus-killer',
    };
    const detections = classifyA11yBaseline({ pageRoute: '/focus-lost', axeViolations: [], focusAfterAction: focus });
    expect(detections.some(d => d.kind === 'focus_lost_after_action')).toBe(true);
  });

  it('emits image_missing_alt from fixtures/a11y-bad/no-alt', () => {
    const violations: A11yViolation[] = [{
      id: 'image-alt',
      impact: 'critical',
      description: 'Images must have alternate text',
      nodes: [
        { target: ['img.logo'], html: '<img src="/logo.png" class="logo">' },
        { target: ['img:nth-child(2)'], html: '<img src="/banner.jpg">' },
      ],
    }];
    const detections = classifyA11yBaseline({ pageRoute: '/no-alt', axeViolations: violations });
    expect(detections.some(d => d.kind === 'image_missing_alt')).toBe(true);
  });

  it('emits form_input_unlabeled from fixtures/a11y-bad/no-label', () => {
    const violations: A11yViolation[] = [{
      id: 'label',
      impact: 'critical',
      description: 'Form elements must have labels',
      nodes: [
        { target: ['input[name="search"]'], html: '<input type="text" name="search" placeholder="Search...">' },
        { target: ['select[name="filter"]'], html: '<select name="filter"></select>' },
      ],
    }];
    const detections = classifyA11yBaseline({ pageRoute: '/no-label', axeViolations: violations });
    expect(detections.some(d => d.kind === 'form_input_unlabeled')).toBe(true);
  });

  it('all 5 a11y BugKinds are emittable from the classifier', () => {
    const violations: A11yViolation[] = [
      { id: 'color-contrast', impact: 'serious', description: '', nodes: [makeNode('.text')] },
      { id: 'image-alt', impact: 'critical', description: '', nodes: [makeNode('img')] },
      { id: 'label', impact: 'critical', description: '', nodes: [makeNode('input')] },
    ];
    const trap: KeyboardTrapResult = {
      trapped: true, selectorClass: 'INPUT', pressCount: 20,
      observedFocusChain: Array(20).fill('INPUT'),
    };
    const focus: FocusAfterActionResult = { lost: true, activeElementTag: 'BODY', triggeringSelector: 'btn' };
    const detections = classifyA11yBaseline({ pageRoute: '/', axeViolations: violations, keyboardTrap: trap, focusAfterAction: focus });
    const emittedKinds = new Set(detections.map(d => d.kind));
    for (const kind of ALL_A11Y_KINDS) {
      expect(emittedKinds.has(kind), `Expected ${kind} to be emitted`).toBe(true);
    }
  });
});
