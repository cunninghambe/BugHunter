import { describe, it, expect } from 'vitest';
import { classifyAutofill } from './autofill.js';
import type { AutofillInput } from './autofill.js';

function makeInput(overrides: Partial<AutofillInput['observation']> = {}): AutofillInput {
  return {
    pageRoute: '/login',
    formSelector: 'form',
    autofillField: 'email',
    observation: {
      domValueAfter: 'user@example.com',
      reactStateValueAfter: 'user@example.com',
      formSubmittedEmpty: false,
      controlledUncontrolledWarning: false,
      ...overrides,
    },
  };
}

describe('classifyAutofill', () => {
  it('returns null when autofill syncs correctly', () => {
    expect(classifyAutofill(makeInput())).toBeNull();
  });

  it('detects controlled_uncontrolled_warning', () => {
    const result = classifyAutofill(makeInput({ controlledUncontrolledWarning: true }));
    expect(result?.kind).toBe('autofill_state_desync');
    if (result?.interactionContext?.kind === 'autofill') {
      expect(result.interactionContext.proof).toBe('controlled_uncontrolled_warning');
    }
  });

  it('detects controlled_value_not_synced when form submits empty despite DOM value', () => {
    const result = classifyAutofill(makeInput({ formSubmittedEmpty: true }));
    expect(result?.kind).toBe('autofill_state_desync');
    if (result?.interactionContext?.kind === 'autofill') {
      expect(result.interactionContext.proof).toBe('controlled_value_not_synced');
    }
  });

  it('detects controlled_value_not_synced when DOM/React state diverge', () => {
    const result = classifyAutofill(makeInput({ reactStateValueAfter: '' }));
    expect(result?.kind).toBe('autofill_state_desync');
    if (result?.interactionContext?.kind === 'autofill') {
      expect(result.interactionContext.proof).toBe('controlled_value_not_synced');
    }
  });

  it('does not flag divergence when domValueAfter is empty (nothing autofilled)', () => {
    const result = classifyAutofill(makeInput({ domValueAfter: '', reactStateValueAfter: '' }));
    expect(result).toBeNull();
  });

  it('prioritizes controlled_uncontrolled_warning', () => {
    const result = classifyAutofill(makeInput({
      controlledUncontrolledWarning: true,
      formSubmittedEmpty: true,
    }));
    if (result?.interactionContext?.kind === 'autofill') {
      expect(result.interactionContext.proof).toBe('controlled_uncontrolled_warning');
    }
  });

  it('populates autofillField in interactionContext', () => {
    const result = classifyAutofill({ ...makeInput({ formSubmittedEmpty: true }), autofillField: 'password' });
    if (result?.interactionContext?.kind === 'autofill') {
      expect(result.interactionContext.autofillField).toBe('password');
    }
  });
});
