// v0.38 detector: animation_state_corruption — detects component state corruption mid-transition.
// Uses 2-of-3 consensus pattern (reusing V19 interleaved_mutations pattern).

import type { BugDetection, InteractionContext } from '../types.js';

export type AnimationCorruptionInput = {
  pageRoute: string;
  transitionTriggerSelector: string;
  observation: {
    /** True when focus landed on a detached DOM node after transition. */
    focusOnDetachedNode: boolean;
    /** True when a modal/dialog is stuck mid-fade (animation frame frozen). */
    modalStuckMidFade: boolean;
    /** True when a React unmount-during-animation warning was emitted. */
    unmountDuringAnimationWarning: boolean;
    /** True when two mutually exclusive animation classes are applied simultaneously. */
    transitionClassOverlap: boolean;
    /** Number of consensus runs that agreed on at least one proof (2-of-3 required). */
    consensusAgreements: number;
    /** Total consensus runs executed. */
    consensusTotal: number;
  };
};

type Proof = 'focus_on_detached_node' | 'modal_dismiss_mid_fade_stuck' | 'unmount_during_animation_warning' | 'transition_class_overlap';

function buildDetection(proof: Proof, input: AnimationCorruptionInput): BugDetection {
  const ctx: InteractionContext = {
    kind: 'animation',
    transitionTriggerSelector: input.transitionTriggerSelector,
    proof,
  };
  return {
    kind: 'animation_state_corruption',
    rootCause: `Animation state corruption: ${proof}`,
    pageRoute: input.pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify animation-corruption observations.
 * Requires consensusAgreements >= 2 out of consensusTotal (2-of-3 by default).
 * Priority order: focus_on_detached_node > modal_dismiss_mid_fade_stuck > unmount_during_animation_warning > transition_class_overlap
 */
export function classifyAnimationCorruption(input: AnimationCorruptionInput): BugDetection | null {
  const { observation } = input;

  // Consensus gate: require >= 2 agreements
  if (observation.consensusAgreements < 2) return null;

  if (observation.focusOnDetachedNode) {
    return buildDetection('focus_on_detached_node', input);
  }

  if (observation.modalStuckMidFade) {
    return buildDetection('modal_dismiss_mid_fade_stuck', input);
  }

  if (observation.unmountDuringAnimationWarning) {
    return buildDetection('unmount_during_animation_warning', input);
  }

  if (observation.transitionClassOverlap) {
    return buildDetection('transition_class_overlap', input);
  }

  return null;
}
