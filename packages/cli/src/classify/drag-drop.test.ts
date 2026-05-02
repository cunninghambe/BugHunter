import { describe, it, expect } from 'vitest';
import { classifyDragDrop } from './drag-drop.js';
import type { DragDropInput } from './drag-drop.js';

function makeInput(overrides: Partial<DragDropInput['observation']> = {}): DragDropInput {
  return {
    pageRoute: '/kanban',
    sourceSelector: '.card',
    targetSelector: '[data-droppable]',
    sourceMime: 'text/plain',
    observation: {
      dragoverDefaultPrevented: true,
      dropOccurred: true,
      domOrderChanged: true,
      consoleErrorsDelta: 0,
      ...overrides,
    },
  };
}

describe('classifyDragDrop', () => {
  it('returns null when drag-and-drop succeeds normally', () => {
    expect(classifyDragDrop(makeInput())).toBeNull();
  });

  it('detects dragover_no_preventDefault', () => {
    const result = classifyDragDrop(makeInput({ dragoverDefaultPrevented: false }));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('drag_drop_failure');
    expect(result?.interactionContext?.kind).toBe('drag_drop');
    if (result?.interactionContext?.kind === 'drag_drop') {
      expect(result.interactionContext.proof).toBe('dragover_no_preventDefault');
    }
  });

  it('detects drop_silent_no_op when DOM order unchanged and no console errors', () => {
    const result = classifyDragDrop(makeInput({ domOrderChanged: false, consoleErrorsDelta: 0 }));
    expect(result?.kind).toBe('drag_drop_failure');
    if (result?.interactionContext?.kind === 'drag_drop') {
      expect(result.interactionContext.proof).toBe('drop_silent_no_op');
    }
  });

  it('does not flag no-DOM-change when there are console errors (error already indicates failure)', () => {
    // consoleErrorsDelta > 0 means the drop produced an error — silent_no_op does not apply
    const result = classifyDragDrop(makeInput({ domOrderChanged: false, consoleErrorsDelta: 1 }));
    expect(result).toBeNull();
  });

  it('detects mime_misinterpretation', () => {
    const result = classifyDragDrop(makeInput({ mimeInterpretationFailed: true }));
    expect(result?.kind).toBe('drag_drop_failure');
    if (result?.interactionContext?.kind === 'drag_drop') {
      expect(result.interactionContext.proof).toBe('mime_misinterpretation');
    }
  });

  it('prioritizes dragover_no_preventDefault over mime_misinterpretation', () => {
    const result = classifyDragDrop(makeInput({
      dragoverDefaultPrevented: false,
      mimeInterpretationFailed: true,
    }));
    if (result?.interactionContext?.kind === 'drag_drop') {
      expect(result.interactionContext.proof).toBe('dragover_no_preventDefault');
    }
  });

  it('populates interactionContext with sourceSelector and targetSelector', () => {
    const result = classifyDragDrop(makeInput({ dragoverDefaultPrevented: false }));
    if (result?.interactionContext?.kind === 'drag_drop') {
      expect(result.interactionContext.sourceSelector).toBe('.card');
      expect(result.interactionContext.targetSelector).toBe('[data-droppable]');
    }
  });
});
