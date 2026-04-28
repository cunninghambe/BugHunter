// Same-shape element collapsing (§ 3.4).
// Collapse signature: (elementTag, role-attr, type-attr, data-testid prefix up to first colon, ancestor stack signature)

import type { Element } from '../types.js';

export type CollapseSignature = string;

export function elementCollapseSignature(el: Element): CollapseSignature {
  // B-10: distinguish undefined (no data-testid) from '' (data-testid="").
  // Both collapsed to '' before, causing deduplication false-positives.
  let testIdPrefix: string;
  if (el.testId === undefined) testIdPrefix = '';
  else if (el.testId === '') testIdPrefix = '<empty>';
  else testIdPrefix = el.testId.split(':')[0] ?? '';
  return [
    el.tag.toLowerCase(),
    el.roleAttr ?? '',
    el.typeAttr ?? '',
    testIdPrefix,
    el.ancestorStack,
  ].join('|');
}

// Returns one representative per distinct signature.
// Input: array of elements from one (role, page).
// Output: deduplicated array (first occurrence per signature wins).
export function collapseElements(elements: Element[]): Element[] {
  const seen = new Set<CollapseSignature>();
  const result: Element[] = [];
  for (const el of elements) {
    const sig = elementCollapseSignature(el);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(el);
    }
  }
  return result;
}

// Form collapse signature: ordered field names + types across the whole form.
export function formCollapseSignature(fieldNames: string[], fieldTypes: string[]): string {
  return fieldNames.map((n, i) => `${n}:${fieldTypes[i] ?? 'text'}`).join(',');
}
