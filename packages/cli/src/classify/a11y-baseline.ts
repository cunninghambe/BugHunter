// A11y baseline classifier — runs once per pageRoute, not per-action.
// Emits 5 BugKinds from axe violations, keyboard-trap probe, and focus-after-action probe.

import type { BugDetection } from '../types.js';
import type { A11yViolation } from './accessibility.js';

export type { A11yViolation };

export type KeyboardTrapResult =
  | { trapped: true; selectorClass: string; pressCount: number; observedFocusChain: string[] }
  | { trapped: false };

export type FocusAfterActionResult =
  | { lost: false; activeElementTag: string }
  | { lost: true; activeElementTag: string | null; triggeringSelector: string };

export type A11yBaselineInput = {
  pageRoute: string;
  axeViolations: A11yViolation[];
  keyboardTrap?: KeyboardTrapResult;
  focusAfterAction?: FocusAfterActionResult;
};

type AxeNode = {
  target?: string[];
  html?: string;
  any?: Array<{ message?: string }>;
};

function selectorFromNode(node: unknown): string {
  const n = node as AxeNode;
  return n.target?.[0] ?? '';
}

function imgSrcFromNode(node: unknown): string | undefined {
  const n = node as AxeNode;
  const html = n.html ?? '';
  const m = /src=["']([^"']+)["']/.exec(html);
  return m?.[1];
}

function nameAttrFromNode(node: unknown): string | undefined {
  const n = node as AxeNode;
  const html = n.html ?? '';
  const m = /name=["']([^"']+)["']/.exec(html);
  return m?.[1];
}

export function classifyA11yBaseline(input: A11yBaselineInput): BugDetection[] {
  const { pageRoute, axeViolations, keyboardTrap, focusAfterAction } = input;
  const detections: BugDetection[] = [];

  for (const violation of axeViolations) {
    if (violation.id === 'color-contrast') {
      for (const node of violation.nodes) {
        const sel = selectorFromNode(node);
        detections.push({
          kind: 'axe_color_contrast_strong',
          rootCause: `Color contrast failure on ${sel !== '' ? sel : 'element'} (WCAG AA 4.5:1 normal / 3:1 large)`,
          pageRoute,
          selectorClass: sel !== '' ? sel : undefined,
          a11yContext: { axeRuleId: 'color-contrast' },
        });
      }
    } else if (violation.id === 'image-alt') {
      for (const node of violation.nodes) {
        const sel = selectorFromNode(node);
        const src = imgSrcFromNode(node);
        detections.push({
          kind: 'image_missing_alt',
          rootCause: `<img> missing alt attribute${src !== undefined ? ` (src: ${src})` : ''}`,
          pageRoute,
          selectorClass: sel !== '' ? sel : undefined,
          a11yContext: { axeRuleId: 'image-alt' },
        });
      }
    } else if (violation.id === 'label') {
      for (const node of violation.nodes) {
        const sel = selectorFromNode(node);
        const name = nameAttrFromNode(node);
        detections.push({
          kind: 'form_input_unlabeled',
          rootCause: `Form input without associated label${name !== undefined ? ` (name="${name}")` : ''}`,
          pageRoute,
          selectorClass: sel !== '' ? sel : undefined,
          a11yContext: { axeRuleId: 'label' },
        });
      }
    }
    // All other axe ids: ignored at baseline — delta path handles them per-action.
  }

  if (keyboardTrap?.trapped === true) {
    detections.push({
      kind: 'keyboard_trap',
      rootCause: `Keyboard trap: focus stays on "${keyboardTrap.selectorClass}" after ${keyboardTrap.pressCount} Tab presses. Note: modal dialogs that intentionally trap focus until close will produce a positive — probe runs on initial page load before any modal opens.`,
      pageRoute,
      selectorClass: keyboardTrap.selectorClass,
      a11yContext: {
        observedFocusChain: keyboardTrap.observedFocusChain,
        pressCount: keyboardTrap.pressCount,
      },
    });
  }

  if (focusAfterAction?.lost === true) {
    detections.push({
      kind: 'focus_lost_after_action',
      rootCause: `Focus lost after action on "${focusAfterAction.triggeringSelector}" — landed on ${focusAfterAction.activeElementTag ?? 'null'}`,
      pageRoute,
      selectorClass: focusAfterAction.triggeringSelector,
      a11yContext: {
        triggeringSelector: focusAfterAction.triggeringSelector,
        activeElementTag: focusAfterAction.activeElementTag,
      },
    });
  }

  return detections;
}
