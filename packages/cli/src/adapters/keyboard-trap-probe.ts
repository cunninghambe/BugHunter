// Keyboard trap probe — fires once per page, before any action, when --a11y-strict is set.
// Presses Tab up to maxPresses times and checks whether focus stays on a single element.

import type { TabScope } from './browser-mcp.js';
import type { KeyboardTrapResult } from '../classify/a11y-baseline.js';

export type { KeyboardTrapResult };

export type TabScope_keyboard = TabScope & {
  keyboard: { press(key: string): Promise<void> };
};

export interface KeyboardTrapProbeInterface {
  probe(scope: TabScope, maxPresses: number): Promise<KeyboardTrapResult>;
}

export class PlaywrightKeyboardTrapProbe implements KeyboardTrapProbeInterface {
  async probe(scope: TabScope, maxPresses: number): Promise<KeyboardTrapResult> {
    // Focus body to start from a known position
    await scope.evaluate('document.body.focus()');

    const chain: string[] = [];

    for (let i = 0; i < maxPresses; i++) {
      // Press Tab via evaluate (camofox keyboard simulation via KeyboardEvent dispatch)
      await scope.evaluate(
        '(function(){ document.activeElement?.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",code:"Tab",bubbles:true,cancelable:true})); })()'
      );

      // Advance focus via native Tab navigation simulation
      await scope.evaluate(
        '(function(){ var el = document.activeElement; if(el === null || el === document.body) return; var focusables = Array.from(document.querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\'-1\'])")); var idx = focusables.indexOf(el); if(idx !== -1 && idx + 1 < focusables.length){ focusables[idx+1].focus(); } else if(focusables.length > 0){ focusables[0].focus(); } })()'
      );

      const result = await scope.evaluate(
        '(function(){ var el = document.activeElement; if(el === null) return "null"; return el.tagName + (el.id ? "#" + el.id : ""); })()'
      );

      const sel = String(result.value ?? '');
      chain.push(sel);
    }

    if (chain.length === 0) return { trapped: false };

    // If all elements in the chain are the same non-body element → trap
    const first = chain[0];
    if (first !== 'BODY' && first !== 'null' && chain.every(s => s === first)) {
      return {
        trapped: true,
        selectorClass: first,
        pressCount: maxPresses,
        observedFocusChain: chain,
      };
    }

    return { trapped: false };
  }
}
