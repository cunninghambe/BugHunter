// v0.38 detector: forced_colors_failure — detects layout/visibility issues under forced-colors: active.

import type { BugDetection, InteractionContext } from '../types.js';

export type ForcedColorsInput = {
  pageRoute: string;
  /** Vision-diff threshold (default 0.18). */
  envVisionThreshold: number;
  observation: {
    /** Vision diff score (0–1) vs baseline screenshot. */
    visionDiffScore: number;
    /** True when the focused element's outline/ring is not visible in forced-colors mode. */
    focusIndicatorInvisible: boolean;
    /** True when a CSS background-image icon becomes invisible (background-image is stripped). */
    backgroundImageIconInvisible: boolean;
    /** True when DOM clipping scan found a clipped element (overflow hidden). */
    domClipDetected: boolean;
  };
};

const MEDIA_QUERY = 'forced-colors: active';

function buildDetection(proof: string, pageRoute?: string): BugDetection {
  const ctx: InteractionContext = { kind: 'env', mediaQuery: MEDIA_QUERY, proof };
  return {
    kind: 'forced_colors_failure',
    rootCause: `Forced-colors issue: ${proof}`,
    pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify forced-colors observations.
 * Priority order: focus_indicator_invisible > background_image_icon_invisible > forced_colors_layout_clip > forced_colors_vision_diff
 */
export function classifyForcedColors(input: ForcedColorsInput): BugDetection | null {
  const { pageRoute, envVisionThreshold, observation } = input;

  if (observation.focusIndicatorInvisible) {
    return buildDetection('focus_indicator_invisible', pageRoute);
  }

  if (observation.backgroundImageIconInvisible) {
    return buildDetection('background_image_icon_invisible', pageRoute);
  }

  if (observation.domClipDetected) {
    return buildDetection('forced_colors_layout_clip', pageRoute);
  }

  if (observation.visionDiffScore >= envVisionThreshold) {
    return buildDetection('forced_colors_vision_diff', pageRoute);
  }

  return null;
}
