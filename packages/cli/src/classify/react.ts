// React-specific error classification (§ 3.5).

import type { BugDetection, ConsoleError } from '../types.js';

const REACT_PATTERNS = [
  /^Warning:/,
  /Cannot update during (an existing state transition|render)/,
  /hydrat/i,
  /did not match/i,
  /error boundary/i,
  /Each child in a list/,
  /Invalid hook call/,
];

export function isReactError(text: string): boolean {
  return REACT_PATTERNS.some(p => p.test(text));
}

export function classifyReactErrors(errors: ConsoleError[], pageRoute: string): BugDetection[] {
  return errors
    .filter(e => isReactError(e.text))
    .map(e => ({
      kind: 'react_error' as const,
      rootCause: e.text,
      stackTrace: e.stack,
      pageRoute,
    }));
}
