import { describe, it, expect } from 'vitest';
import { classifyAnimationCorruption } from './animation-corruption.js';
import type { AnimationCorruptionInput } from './animation-corruption.js';

function makeInput(overrides: Partial<AnimationCorruptionInput['observation']> = {}): AnimationCorruptionInput {
  return {
    pageRoute: '/modal',
    transitionTriggerSelector: '.open-modal-btn',
    observation: {
      focusOnDetachedNode: false,
      unmountDuringAnimationWarning: false,
      transitionClassOverlap: false,
      modalStuckMidFade: false,
      consensusAgreements: 3,
      consensusTotal: 3,
      ...overrides,
    },
  };
}

describe('classifyAnimationCorruption', () => {
  it('returns null when mid-transition action causes no issue', () => {
    expect(classifyAnimationCorruption(makeInput())).toBeNull();
  });

  it('detects focus_on_detached_node', () => {
    const result = classifyAnimationCorruption(makeInput({ focusOnDetachedNode: true }));
    expect(result?.kind).toBe('animation_state_corruption');
    if (result?.interactionContext?.kind === 'animation') {
      expect(result.interactionContext.proof).toBe('focus_on_detached_node');
    }
  });

  it('detects modal_dismiss_mid_fade_stuck', () => {
    const result = classifyAnimationCorruption(makeInput({ modalStuckMidFade: true }));
    expect(result?.kind).toBe('animation_state_corruption');
    if (result?.interactionContext?.kind === 'animation') {
      expect(result.interactionContext.proof).toBe('modal_dismiss_mid_fade_stuck');
    }
  });

  it('detects unmount_during_animation_warning', () => {
    const result = classifyAnimationCorruption(makeInput({ unmountDuringAnimationWarning: true }));
    expect(result?.kind).toBe('animation_state_corruption');
    if (result?.interactionContext?.kind === 'animation') {
      expect(result.interactionContext.proof).toBe('unmount_during_animation_warning');
    }
  });

  it('detects transition_class_overlap', () => {
    const result = classifyAnimationCorruption(makeInput({ transitionClassOverlap: true }));
    expect(result?.kind).toBe('animation_state_corruption');
    if (result?.interactionContext?.kind === 'animation') {
      expect(result.interactionContext.proof).toBe('transition_class_overlap');
    }
  });

  it('suppresses finding when consensus is below threshold (1/3)', () => {
    const result = classifyAnimationCorruption(makeInput({
      focusOnDetachedNode: true,
      consensusAgreements: 1,
      consensusTotal: 3,
    }));
    expect(result).toBeNull();
  });

  it('allows finding when consensus is at threshold (2/3)', () => {
    const result = classifyAnimationCorruption(makeInput({
      focusOnDetachedNode: true,
      consensusAgreements: 2,
      consensusTotal: 3,
    }));
    expect(result).not.toBeNull();
  });

  it('prioritizes focus_on_detached_node over modal_dismiss', () => {
    const result = classifyAnimationCorruption(makeInput({
      focusOnDetachedNode: true,
      modalStuckMidFade: true,
    }));
    if (result?.interactionContext?.kind === 'animation') {
      expect(result.interactionContext.proof).toBe('focus_on_detached_node');
    }
  });
});
