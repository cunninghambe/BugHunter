import { describe, it, expect } from 'vitest';
import { classifyZoomLayout } from './zoom-layout.js';
import type { ZoomLayoutInput } from './zoom-layout.js';

function makeInput(overrides: Partial<ZoomLayoutInput['observation']> = {}): ZoomLayoutInput {
  return {
    pageRoute: '/products',
    observation: {
      horizontalScrollbarPresent: false,
      clippedFocusableSelector: null,
      stickyHeaderOverlap: false,
      ...overrides,
    },
  };
}

describe('classifyZoomLayout', () => {
  it('returns null when layout is intact at 200% zoom', () => {
    expect(classifyZoomLayout(makeInput())).toBeNull();
  });

  it('detects horizontal_scrollbar_at_zoom_200', () => {
    const result = classifyZoomLayout(makeInput({ horizontalScrollbarPresent: true }));
    expect(result?.kind).toBe('zoom_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('horizontal_scrollbar_at_zoom_200');
    }
  });

  it('detects focusable_element_clipped_at_zoom_200', () => {
    const result = classifyZoomLayout(makeInput({ clippedFocusableSelector: 'button.submit' }));
    expect(result?.kind).toBe('zoom_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('focusable_element_clipped_at_zoom_200');
      expect(result.interactionContext.violatingSelector).toBe('button.submit');
    }
  });

  it('detects sticky_header_overlap_at_zoom_200', () => {
    const result = classifyZoomLayout(makeInput({ stickyHeaderOverlap: true }));
    expect(result?.kind).toBe('zoom_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('sticky_header_overlap_at_zoom_200');
    }
  });

  it('prioritizes horizontal_scrollbar over clipped_focusable', () => {
    const result = classifyZoomLayout(makeInput({
      horizontalScrollbarPresent: true,
      clippedFocusableSelector: 'a.link',
    }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('horizontal_scrollbar_at_zoom_200');
    }
  });

  it('prioritizes clipped_focusable over sticky_header_overlap', () => {
    const result = classifyZoomLayout(makeInput({
      clippedFocusableSelector: 'input#search',
      stickyHeaderOverlap: true,
    }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('focusable_element_clipped_at_zoom_200');
    }
  });

  it('sets mediaQuery to zoom: 200%', () => {
    const result = classifyZoomLayout(makeInput({ horizontalScrollbarPresent: true }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.mediaQuery).toBe('zoom: 200%');
    }
  });
});
