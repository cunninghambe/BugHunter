// v0.38 detector: dark_mode_layout_break — detects layout/contrast issues under prefers-color-scheme: dark.

import type { BugDetection, InteractionContext } from '../types.js';

export type DarkModeInput = {
  pageRoute: string;
  /** Vision-diff threshold (default 0.18). */
  envVisionThreshold: number;
  observation: {
    /** Vision diff score (0–1) between light and dark screenshots. */
    visionDiffScore: number;
    /** Fraction of diff pixels that fall in text regions (0–1). */
    textRegionDiffFraction: number;
    /** Number of low-contrast nodes in dark mode. */
    lowContrastNodeCount: number;
    /** Number of low-contrast nodes in baseline (light) mode. */
    lowContrastNodeCountBaseline: number;
    /** True when an SVG icon becomes invisible (same color as background) in dark mode. */
    svgIconInvisible: boolean;
  };
};

const MEDIA_QUERY = 'prefers-color-scheme: dark';
const CONTRAST_REGRESSION_THRESHOLD = 5;

function buildDetection(proof: string, pageRoute?: string): BugDetection {
  const ctx: InteractionContext = { kind: 'env', mediaQuery: MEDIA_QUERY, proof };
  return {
    kind: 'dark_mode_layout_break',
    rootCause: `Dark mode issue: ${proof}`,
    pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify dark-mode observations.
 * Priority order: svg_icon_invisible > contrast_collapsed > mass_text_color_collision
 */
export function classifyDarkMode(input: DarkModeInput): BugDetection | null {
  const { pageRoute, envVisionThreshold, observation } = input;

  if (observation.svgIconInvisible) {
    return buildDetection('svg_icon_invisible_in_dark', pageRoute);
  }

  const contrastRegression = observation.lowContrastNodeCount - observation.lowContrastNodeCountBaseline;
  if (contrastRegression >= CONTRAST_REGRESSION_THRESHOLD) {
    return buildDetection('contrast_collapsed_in_dark', pageRoute);
  }

  if (
    observation.visionDiffScore >= envVisionThreshold &&
    observation.textRegionDiffFraction >= 0.2
  ) {
    return buildDetection('mass_text_color_collision_under_dark', pageRoute);
  }

  return null;
}
