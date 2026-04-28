// Focus-after-action probe — called after each successful action to detect focus loss.
// Performance budget: ≤30ms per action (single evaluate call).

import type { TabScope } from './browser-mcp.js';
import type { FocusAfterActionResult } from '../classify/a11y-baseline.js';

export type { FocusAfterActionResult };

export interface FocusTrackerInterface {
  observe(scope: TabScope, triggeringSelector: string): Promise<FocusAfterActionResult>;
}

export class FocusTracker implements FocusTrackerInterface {
  async observe(scope: TabScope, triggeringSelector: string): Promise<FocusAfterActionResult> {
    const result = await scope.evaluate(
      '(function(){ var el = document.activeElement; if(el === null) return null; return el.tagName; })()'
    );

    const tag = result.value === null || result.value === undefined ? null : String(result.value);

    if (tag === null || tag === 'BODY') {
      return { lost: true, activeElementTag: tag, triggeringSelector };
    }

    return { lost: false, activeElementTag: tag };
  }
}
