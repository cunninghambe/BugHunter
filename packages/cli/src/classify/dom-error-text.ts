// DOM error-text detection (§ 3.5).

import type { BugDetection } from '../types.js';

const DOM_ERROR_PATTERN = /(?:something went wrong|an error occurred|unable to|failed to)/i;

// Script to check for error text in DOM post-action.
export const CHECK_DOM_ERROR_SCRIPT = `
(function() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (${DOM_ERROR_PATTERN.toString()}.test(node.textContent)) {
      return { found: true, text: node.textContent.trim().slice(0, 200) };
    }
  }
  return { found: false };
})()
`;

export function classifyDomErrorText(
  domSnippet: string,
  pageRoute: string,
  selectorClass: string
): BugDetection | null {
  if (!DOM_ERROR_PATTERN.test(domSnippet)) return null;
  return {
    kind: 'dom_error_text',
    rootCause: `Error text detected in DOM: "${domSnippet.slice(0, 80)}"`,
    pageRoute,
    selectorClass,
  };
}
