// v0.38 detector: autofill_state_desync — detects React/state desync when browser autofill fires.

import type { BugDetection, InteractionContext } from '../types.js';

export type AutofillInput = {
  pageRoute: string;
  formSelector: string;
  autofillField: 'email' | 'password' | 'cc' | 'address';
  observation: {
    /** DOM value of the autofilled field after autofill. */
    domValueAfter: string;
    /** React state value of the field after autofill. */
    reactStateValueAfter: string;
    /** True when form was submitted but the field value was empty/missing (autofill not synced). */
    formSubmittedEmpty: boolean;
    /** True when a React controlled/uncontrolled component warning was emitted after autofill. */
    controlledUncontrolledWarning: boolean;
  };
};

function buildDetection(proof: string, input: AutofillInput): BugDetection {
  const ctx: InteractionContext = {
    kind: 'autofill',
    formSelector: input.formSelector,
    autofillField: input.autofillField,
    proof,
  };
  return {
    kind: 'autofill_state_desync',
    rootCause: `Autofill state desync: ${proof}`,
    pageRoute: input.pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify autofill observations.
 * Priority order: controlled_uncontrolled_warning > controlled_value_not_synced
 *
 * Divergence check is only relevant when domValueAfter is non-empty
 * (if nothing was autofilled, no assertion is possible).
 */
export function classifyAutofill(input: AutofillInput): BugDetection | null {
  const { observation } = input;

  if (observation.controlledUncontrolledWarning) {
    return buildDetection('controlled_uncontrolled_warning', input);
  }

  // Only flag sync issues when autofill actually populated the DOM field
  if (observation.domValueAfter !== '') {
    if (observation.formSubmittedEmpty || observation.reactStateValueAfter !== observation.domValueAfter) {
      return buildDetection('controlled_value_not_synced', input);
    }
  }

  return null;
}
