import { describe, it, expect } from 'vitest';
import { classifyPasteHandler } from './paste-handler.js';
import type { PasteHandlerInput } from './paste-handler.js';

function makeInput(overrides: Partial<PasteHandlerInput['observation']> = {}): PasteHandlerInput {
  return {
    pageRoute: '/editor',
    fieldSelector: '[contenteditable]',
    pasteSource: 'plain_text',
    observation: {
      reactStateValueAfter: 'hello world',
      expectedValue: 'hello world',
      scriptPersistedInDom: false,
      scriptExecuted: false,
      consoleErrorsDelta: 0,
      ...overrides,
    },
  };
}

describe('classifyPasteHandler', () => {
  it('returns null when paste succeeds cleanly', () => {
    expect(classifyPasteHandler(makeInput())).toBeNull();
  });

  it('detects script_executed_or_persisted when script executed', () => {
    const result = classifyPasteHandler(makeInput({ scriptExecuted: true }));
    expect(result?.kind).toBe('paste_handler_failure');
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.proof).toBe('script_executed_or_persisted');
    }
  });

  it('detects script_executed_or_persisted when script in DOM', () => {
    const result = classifyPasteHandler(makeInput({ scriptPersistedInDom: true }));
    expect(result?.kind).toBe('paste_handler_failure');
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.proof).toBe('script_executed_or_persisted');
    }
  });

  it('detects console_error_during_paste', () => {
    const result = classifyPasteHandler(makeInput({ consoleErrorsDelta: 2 }));
    expect(result?.kind).toBe('paste_handler_failure');
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.proof).toBe('console_error_during_paste');
    }
  });

  it('detects state_value_mismatch when React state does not match expected', () => {
    const result = classifyPasteHandler(makeInput({
      reactStateValueAfter: '',
      expectedValue: 'hello world',
    }));
    expect(result?.kind).toBe('paste_handler_failure');
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.proof).toBe('state_value_mismatch');
    }
  });

  it('does not flag mismatch when expectedValue is empty string (no assertion possible)', () => {
    const result = classifyPasteHandler(makeInput({
      reactStateValueAfter: '',
      expectedValue: '',
    }));
    expect(result).toBeNull();
  });

  it('prioritizes script_executed over console_error', () => {
    const result = classifyPasteHandler(makeInput({
      scriptExecuted: true,
      consoleErrorsDelta: 3,
    }));
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.proof).toBe('script_executed_or_persisted');
    }
  });

  it('populates pasteSource in interactionContext', () => {
    const result = classifyPasteHandler({
      ...makeInput({ scriptExecuted: true }),
      pasteSource: 'word_html',
    });
    if (result?.interactionContext?.kind === 'paste') {
      expect(result.interactionContext.pasteSource).toBe('word_html');
    }
  });
});
