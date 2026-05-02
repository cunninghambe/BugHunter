// v0.38 detector: zoom_layout_break — detects layout issues at 200% browser zoom.

import type { BugDetection, InteractionContext } from '../types.js';

export type ZoomLayoutInput = {
  pageRoute: string;
  observation: {
    /** True when a horizontal scrollbar appears at 200% zoom that wasn't present at 100%. */
    horizontalScrollbarPresent: boolean;
    /** CSS selector of the first focusable element that is clipped at 200% zoom. Null if none. */
    clippedFocusableSelector: string | null;
    /** True when a sticky header overlaps main content at 200% zoom. */
    stickyHeaderOverlap: boolean;
  };
};

const MEDIA_QUERY = 'zoom: 200%';

function buildDetection(proof: string, violatingSelector?: string, pageRoute?: string): BugDetection {
  const ctx: InteractionContext = { kind: 'env', mediaQuery: MEDIA_QUERY, proof, ...(violatingSelector !== undefined ? { violatingSelector } : {}) };
  return {
    kind: 'zoom_layout_break',
    rootCause: `Layout break at 200% zoom: ${proof}${violatingSelector !== undefined ? ` (${violatingSelector})` : ''}`,
    pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify zoom-layout observations at 200% browser zoom.
 * Priority order: horizontal_scrollbar > clipped_focusable > sticky_header_overlap
 */
export function classifyZoomLayout(input: ZoomLayoutInput): BugDetection | null {
  const { pageRoute, observation } = input;

  if (observation.horizontalScrollbarPresent) {
    return buildDetection('horizontal_scrollbar_at_zoom_200', undefined, pageRoute);
  }

  if (observation.clippedFocusableSelector !== null) {
    return buildDetection('focusable_element_clipped_at_zoom_200', observation.clippedFocusableSelector, pageRoute);
  }

  if (observation.stickyHeaderOverlap) {
    return buildDetection('sticky_header_overlap_at_zoom_200', undefined, pageRoute);
  }

  return null;
}
