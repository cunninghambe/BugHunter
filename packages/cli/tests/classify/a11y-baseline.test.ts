import { describe, it, expect } from 'vitest';
import { classifyA11yBaseline } from '../../src/classify/a11y-baseline.js';
import type { A11yViolation, KeyboardTrapResult, FocusAfterActionResult } from '../../src/classify/a11y-baseline.js';

const PAGE = '/dashboard';

function makeNode(target: string, html = ''): unknown {
  return { target: [target], html };
}

describe('classifyA11yBaseline — color contrast', () => {
  it('emits axe_color_contrast_strong for each color-contrast node', () => {
    const violations: A11yViolation[] = [{
      id: 'color-contrast',
      impact: 'serious',
      description: 'Insufficient color contrast',
      nodes: [makeNode('.muted-text'), makeNode('.btn-secondary')],
    }];
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: violations });
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('axe_color_contrast_strong');
    expect(result[0].pageRoute).toBe(PAGE);
    expect(result[0].selectorClass).toBe('.muted-text');
    expect(result[0].a11yContext?.axeRuleId).toBe('color-contrast');
  });

  it('does not emit for violations other than the 3 baseline ids', () => {
    const violations: A11yViolation[] = [{
      id: 'aria-required-attr',
      impact: 'critical',
      description: 'Aria required',
      nodes: [makeNode('button')],
    }];
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: violations });
    expect(result).toHaveLength(0);
  });
});

describe('classifyA11yBaseline — image alt', () => {
  it('emits image_missing_alt with src extracted from html', () => {
    const violations: A11yViolation[] = [{
      id: 'image-alt',
      impact: 'critical',
      description: 'Image missing alt',
      nodes: [makeNode('img.logo', '<img src="/logo.png" class="logo">')],
    }];
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: violations });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('image_missing_alt');
    expect(result[0].rootCause).toContain('/logo.png');
  });
});

describe('classifyA11yBaseline — form label', () => {
  it('emits form_input_unlabeled with name attribute extracted', () => {
    const violations: A11yViolation[] = [{
      id: 'label',
      impact: 'critical',
      description: 'Form element has no label',
      nodes: [makeNode('input#search', '<input name="q" id="search">')],
    }];
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: violations });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('form_input_unlabeled');
    expect(result[0].rootCause).toContain('name="q"');
  });
});

describe('classifyA11yBaseline — keyboard trap', () => {
  it('emits keyboard_trap when probe returns trapped:true', () => {
    const trap: KeyboardTrapResult = {
      trapped: true,
      selectorClass: 'INPUT#modal-input',
      pressCount: 20,
      observedFocusChain: Array(20).fill('INPUT#modal-input'),
    };
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: [], keyboardTrap: trap });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('keyboard_trap');
    expect(result[0].a11yContext?.pressCount).toBe(20);
    expect(result[0].a11yContext?.observedFocusChain).toHaveLength(20);
  });

  it('emits nothing when probe returns trapped:false', () => {
    const trap: KeyboardTrapResult = { trapped: false };
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: [], keyboardTrap: trap });
    expect(result).toHaveLength(0);
  });
});

describe('classifyA11yBaseline — focus lost', () => {
  it('emits focus_lost_after_action when focus lands on BODY', () => {
    const focus: FocusAfterActionResult = {
      lost: true,
      activeElementTag: 'BODY',
      triggeringSelector: 'button#close',
    };
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: [], focusAfterAction: focus });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('focus_lost_after_action');
    expect(result[0].a11yContext?.triggeringSelector).toBe('button#close');
    expect(result[0].a11yContext?.activeElementTag).toBe('BODY');
  });

  it('emits nothing when focus is preserved on a real element', () => {
    const focus: FocusAfterActionResult = { lost: false, activeElementTag: 'INPUT' };
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: [], focusAfterAction: focus });
    expect(result).toHaveLength(0);
  });

  it('emits focus_lost_after_action when activeElementTag is null', () => {
    const focus: FocusAfterActionResult = {
      lost: true,
      activeElementTag: null,
      triggeringSelector: 'button#submit',
    };
    const result = classifyA11yBaseline({ pageRoute: PAGE, axeViolations: [], focusAfterAction: focus });
    expect(result).toHaveLength(1);
    expect(result[0].a11yContext?.activeElementTag).toBeNull();
  });
});
