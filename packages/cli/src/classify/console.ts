// Console error classification (§ 3.5).

import type { ConsoleError, BugDetection, BugKind } from '../types.js';

const REACT_WARNING_PATTERNS = [
  /^Warning: /,
  /Cannot update during (an existing state transition|render)/,
  /hydration/i,
  /did not match/i,
  /error boundary/i,
];

// Markers of uncaught errors (window.onerror / unhandledrejection / pageerror)
// vs deliberately-logged errors. Per spec §3.5 priority slot 1 (highest).
const UNCAUGHT_PATTERNS = [
  /^Uncaught /,
  /^Unhandled (promise )?rejection/i,
  /unhandledrejection/i,
];

function classifyKind(text: string): BugKind {
  if (UNCAUGHT_PATTERNS.some(p => p.test(text))) return 'unhandled_exception';
  if (REACT_WARNING_PATTERNS.some(p => p.test(text))) return 'react_error';
  return 'console_error';
}

export function classifyConsoleErrors(
  errors: ConsoleError[],
  pageRoute: string
): BugDetection[] {
  return errors.map(e => ({
    kind: classifyKind(e.text),
    rootCause: e.text,
    stackTrace: e.stack,
    pageRoute,
  } satisfies BugDetection));
}
