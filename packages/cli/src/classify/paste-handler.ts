// v0.38 detector: paste_handler_failure — detects failures in clipboard paste handling.

import type { BugDetection, InteractionContext } from '../types.js';

export type PasteHandlerInput = {
  pageRoute: string;
  fieldSelector: string;
  pasteSource: 'word_html' | 'excel_html' | 'plain_text' | 'styled_html_with_script';
  observation: {
    /** React state value after paste. */
    reactStateValueAfter: string;
    /** Expected value (the text that was pasted). Empty string = no assertion possible. */
    expectedValue: string;
    /** True when a <script> tag content was persisted in the DOM. */
    scriptPersistedInDom: boolean;
    /** True when a script was executed during paste (window.eval or inline script fired). */
    scriptExecuted: boolean;
    /** Number of new console errors emitted during paste. */
    consoleErrorsDelta: number;
  };
};

function buildDetection(proof: string, input: PasteHandlerInput): BugDetection {
  const ctx: InteractionContext = {
    kind: 'paste',
    fieldSelector: input.fieldSelector,
    pasteSource: input.pasteSource,
    proof,
  };
  return {
    kind: 'paste_handler_failure',
    rootCause: `Paste handler failure: ${proof}`,
    pageRoute: input.pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify paste-handler observations.
 * Priority order: script_executed_or_persisted > console_error_during_paste > state_value_mismatch
 */
export function classifyPasteHandler(input: PasteHandlerInput): BugDetection | null {
  const { observation } = input;

  if (observation.scriptExecuted || observation.scriptPersistedInDom) {
    return buildDetection('script_executed_or_persisted', input);
  }

  if (observation.consoleErrorsDelta > 0) {
    return buildDetection('console_error_during_paste', input);
  }

  // Only flag mismatch when expectedValue is non-empty (otherwise no assertion is possible)
  if (observation.expectedValue !== '' && observation.reactStateValueAfter !== observation.expectedValue) {
    return buildDetection('state_value_mismatch', input);
  }

  return null;
}
