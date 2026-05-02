// Pure geometric diff for locale-stress layout checks (§4.4).

import type { DOMRectLite } from '../../types.js';

export type GeometricFinding = {
  kind: 'clipped_text' | 'overlap_pair' | 'off_screen' | 'parent_overflow';
  selector: string;
  pairSelector?: string;
  certainty: 'high' | 'ambiguous';
};

function rectsIntersect(a: DOMRectLite, b: DOMRectLite): { x: number; y: number } {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return { x: dx, y: dy };
}

function isOffScreen(rect: DOMRectLite, viewport: { w: number; h: number }): boolean {
  return rect.x + rect.w < 0 || rect.x > viewport.w || rect.y + rect.h < 0 || rect.y > viewport.h;
}

export function checkGeometry(
  ltr: Record<string, DOMRectLite>,
  variant: Record<string, DOMRectLite>,
  viewport: { w: number; h: number },
): GeometricFinding[] {
  const findings: GeometricFinding[] = [];
  const selectors = Object.keys(variant);

  // Check parent_overflow: variant page's scrollWidth > viewport + 16 while LTR was not
  const variantPageOverflow = (variant['__page__']?.w ?? 0) > viewport.w + 16;
  const ltrPageOverflow = (ltr['__page__']?.w ?? 0) > viewport.w + 16;
  if (variantPageOverflow && !ltrPageOverflow) {
    findings.push({ kind: 'parent_overflow', selector: '__page__', certainty: 'high' });
  }

  for (const sel of selectors) {
    if (sel === '__page__') continue;
    const vRect = variant[sel];
    const lRect = ltr[sel];
    if (vRect === undefined) continue;

    // off_screen: element is wholly outside viewport in variant
    if (isOffScreen(vRect, viewport) && (lRect === undefined || !isOffScreen(lRect, viewport))) {
      findings.push({ kind: 'off_screen', selector: sel, certainty: 'high' });
      continue;
    }

    // clipped_text: width grew by more than 2px in variant vs LTR (heuristic)
    if (lRect !== undefined && vRect.w > lRect.w + 2) {
      findings.push({ kind: 'clipped_text', selector: sel, certainty: 'ambiguous' });
    }
  }

  // overlap_pair: sibling pairs that overlap in variant but not in LTR
  for (let i = 0; i < selectors.length; i++) {
    for (let j = i + 1; j < selectors.length; j++) {
      const selA = selectors[i];
      const selB = selectors[j];
      if (selA === '__page__' || selB === '__page__') continue;
      const vA = variant[selA];
      const vB = variant[selB];
      if (vA === undefined || vB === undefined) continue;

      const vIntersect = rectsIntersect(vA, vB);
      if (vIntersect.x <= 0 || vIntersect.y <= 0) continue;

      const lA = ltr[selA];
      const lB = ltr[selB];
      if (lA !== undefined && lB !== undefined) {
        const lIntersect = rectsIntersect(lA, lB);
        if (lIntersect.x > 0 && lIntersect.y > 0) continue; // already overlapping in LTR
      }

      const isSmall = vIntersect.x <= 8 || vIntersect.y <= 8;
      findings.push({
        kind: 'overlap_pair',
        selector: selA,
        pairSelector: selB,
        certainty: isSmall ? 'ambiguous' : 'high',
      });
    }
  }

  return findings;
}
