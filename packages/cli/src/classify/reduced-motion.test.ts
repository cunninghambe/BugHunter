import { describe, it, expect } from 'vitest';
import { classifyReducedMotion } from './reduced-motion.js';
import type { ReducedMotionInput } from './reduced-motion.js';

function makeInput(overrides: Partial<ReducedMotionInput['observation']> = {}): ReducedMotionInput {
  return {
    pageRoute: '/home',
    observation: {
      animatingElementSelector: null,
      autoplayVideoStillPlaying: false,
      ...overrides,
    },
  };
}

describe('classifyReducedMotion', () => {
  it('returns null when no animations under reduced-motion', () => {
    expect(classifyReducedMotion(makeInput())).toBeNull();
  });

  it('detects animation_still_running_under_reduced_motion', () => {
    const result = classifyReducedMotion(makeInput({ animatingElementSelector: '.carousel' }));
    expect(result?.kind).toBe('reduced_motion_violation');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('animation_still_running_under_reduced_motion');
      expect(result.interactionContext.violatingSelector).toBe('.carousel');
    }
  });

  it('detects autoplay_video_under_reduced_motion', () => {
    const result = classifyReducedMotion(makeInput({ autoplayVideoStillPlaying: true }));
    expect(result?.kind).toBe('reduced_motion_violation');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('autoplay_video_under_reduced_motion');
    }
  });

  it('prioritizes animating element over autoplay video', () => {
    const result = classifyReducedMotion(makeInput({
      animatingElementSelector: '.spinner',
      autoplayVideoStillPlaying: true,
    }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('animation_still_running_under_reduced_motion');
    }
  });

  it('sets mediaQuery correctly', () => {
    const result = classifyReducedMotion(makeInput({ animatingElementSelector: '.spinner' }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.mediaQuery).toBe('prefers-reduced-motion: reduce');
    }
  });
});
