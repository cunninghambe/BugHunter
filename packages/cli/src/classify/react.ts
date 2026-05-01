// React-specific error classification (§ 3.5) — extended for v0.5 T20 (hydration_mismatch).

import type { BugDetection, ConsoleError } from '../types.js';

const HYDRATION_PATTERNS = [
  /Hydration failed because/i,
  /Text content does not match server-rendered HTML/i,
  /Did not match\. Server:.*Client:/i,
  // React 16
  /Did not expect server HTML to contain/i,
];

const REACT_PATTERNS = [
  /^Warning:/,
  /Cannot update during (an existing state transition|render)/,
  /hydrat/i,
  /d(?:id|oes) not match/i,
  /error boundary/i,
  /Each child in a list/,
  /Invalid hook call/,
];

export function isHydrationError(text: string): boolean {
  return HYDRATION_PATTERNS.some(p => p.test(text));
}

export function isReactError(text: string): boolean {
  return REACT_PATTERNS.some(p => p.test(text));
}

export function classifyReactErrors(errors: ConsoleError[], pageRoute: string): BugDetection[] {
  return errors.map(e => {
    // Hydration errors are a more-specific subkind of react_error.
    if (isHydrationError(e.text)) {
      return {
        kind: 'hydration_mismatch' as const,
        rootCause: e.text,
        stackTrace: e.stack,
        pageRoute,
      };
    }
    if (isReactError(e.text)) {
      return {
        kind: 'react_error' as const,
        rootCause: e.text,
        stackTrace: e.stack,
        pageRoute,
      };
    }
    // V24: fall through to console_error for non-React errors so classifyReactErrors
    // is a complete drop-in replacement for classifyConsoleErrors (spec §3.4, option B).
    return {
      kind: 'console_error' as const,
      rootCause: e.text,
      stackTrace: e.stack,
      pageRoute,
    };
  });
}
