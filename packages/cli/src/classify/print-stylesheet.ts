// v0.38 detector: print_stylesheet_broken — detects print layout breakage.

import type { BugDetection, InteractionContext } from '../types.js';

export type PrintStylesheetInput = {
  pageRoute: string;
  /** When true, fire no_print_stylesheet_defined even without explicit opt-in. */
  printStylesheetRequired: boolean;
  /** Vision-diff threshold (default 0.18). */
  envVisionThreshold: number;
  observation: {
    /** Vision diff score between screen and print screenshots. */
    visionDiffScore: number;
    /** Fraction of the page area covered by the diff (0–1). */
    visionDiffCoverage: number;
    /** True when horizontal overflow is detected in print view. */
    horizontalOverflow: boolean;
    /** True when main content is completely hidden in print view. */
    contentHidden: boolean;
    /** True when no @media print rule or print stylesheet was found. */
    noPrintStylesheet: boolean;
    /** Number of visible characters on the print page. */
    visibleContentLength: number;
  };
};

const MEDIA_QUERY = '@media print';
const PRINT_COVERAGE_THRESHOLD = 0.3;
const TRIVIAL_CONTENT_LENGTH = 500;

function buildDetection(proof: string, pageRoute?: string): BugDetection {
  const ctx: InteractionContext = { kind: 'env', mediaQuery: MEDIA_QUERY, proof };
  return {
    kind: 'print_stylesheet_broken',
    rootCause: `Print stylesheet issue: ${proof}`,
    pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify print-stylesheet observations.
 * Priority order: content_hidden > horizontal_overflow > mass_layout_diff > no_print_stylesheet
 */
export function classifyPrintStylesheet(input: PrintStylesheetInput): BugDetection | null {
  const { pageRoute, printStylesheetRequired, envVisionThreshold, observation } = input;

  if (observation.contentHidden) {
    return buildDetection('print_content_hidden', pageRoute);
  }

  if (observation.horizontalOverflow) {
    return buildDetection('print_horizontal_overflow', pageRoute);
  }

  if (
    observation.visionDiffScore >= envVisionThreshold &&
    observation.visionDiffCoverage >= PRINT_COVERAGE_THRESHOLD
  ) {
    return buildDetection('mass_layout_diff_in_print', pageRoute);
  }

  if (
    printStylesheetRequired &&
    observation.noPrintStylesheet &&
    observation.visibleContentLength > TRIVIAL_CONTENT_LENGTH
  ) {
    return buildDetection('no_print_stylesheet_defined', pageRoute);
  }

  return null;
}
