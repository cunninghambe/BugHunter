// Console error classification (§ 3.5).

import type { ConsoleError, BugDetection } from '../types.js';

const REACT_WARNING_PATTERNS = [
  /^Warning: /,
  /Cannot update during (an existing state transition|render)/,
  /hydration/i,
  /did not match/i,
  /error boundary/i,
];

export function classifyConsoleErrors(
  errors: ConsoleError[],
  pageRoute: string
): BugDetection[] {
  return errors.map(e => {
    const isReact = REACT_WARNING_PATTERNS.some(p => p.test(e.text));
    return {
      kind: isReact ? 'react_error' : 'console_error',
      rootCause: e.text,
      stackTrace: e.stack,
      pageRoute,
    } satisfies BugDetection;
  });
}
