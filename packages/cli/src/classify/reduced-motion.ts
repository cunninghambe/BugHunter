// v0.38 detector: reduced_motion_violation — detects animations still running under prefers-reduced-motion: reduce.

import type { BugDetection, InteractionContext } from '../types.js';

export type ReducedMotionInput = {
  pageRoute: string;
  observation: {
    /** CSS selector of a still-animating element under reduced-motion. Null if none. */
    animatingElementSelector: string | null;
    /** True when an autoplay video continues playing under reduced-motion. */
    autoplayVideoStillPlaying: boolean;
  };
};

const MEDIA_QUERY = 'prefers-reduced-motion: reduce';

function buildDetection(proof: string, violatingSelector?: string, pageRoute?: string): BugDetection {
  const ctx: InteractionContext = {
    kind: 'env',
    mediaQuery: MEDIA_QUERY,
    proof,
    ...(violatingSelector !== undefined ? { violatingSelector } : {}),
  };
  return {
    kind: 'reduced_motion_violation',
    rootCause: `Animation running under reduced-motion: ${proof}${violatingSelector !== undefined ? ` (${violatingSelector})` : ''}`,
    pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify reduced-motion observations.
 * Priority order: animating_element > autoplay_video
 */
export function classifyReducedMotion(input: ReducedMotionInput): BugDetection | null {
  const { pageRoute, observation } = input;

  if (observation.animatingElementSelector !== null) {
    return buildDetection('animation_still_running_under_reduced_motion', observation.animatingElementSelector, pageRoute);
  }

  if (observation.autoplayVideoStillPlaying) {
    return buildDetection('autoplay_video_under_reduced_motion', undefined, pageRoute);
  }

  return null;
}
