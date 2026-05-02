// v0.38 detector: drag_drop_failure — detects failures in drag-and-drop interactions.

import type { BugDetection, InteractionContext } from '../types.js';

export type DragDropInput = {
  pageRoute: string;
  sourceSelector: string;
  targetSelector: string;
  sourceMime: string;
  observation: {
    /** True when dragover event's default was prevented (app accepted the drop). */
    dragoverDefaultPrevented: boolean;
    /** True when the drop event fired. */
    dropOccurred: boolean;
    /** True when DOM order/content changed after the drop. */
    domOrderChanged: boolean;
    /** Number of new console errors emitted during the drag-drop sequence. */
    consoleErrorsDelta: number;
    /** True when the MIME type was misinterpreted (dataTransfer returned wrong type). */
    mimeInterpretationFailed?: boolean;
  };
};

function buildDetection(proof: string, input: DragDropInput): BugDetection {
  const ctx: InteractionContext = {
    kind: 'drag_drop',
    sourceSelector: input.sourceSelector,
    targetSelector: input.targetSelector,
    sourceMime: input.sourceMime,
    proof,
  };
  return {
    kind: 'drag_drop_failure',
    rootCause: `Drag-drop failure: ${proof}`,
    pageRoute: input.pageRoute,
    interactionContext: ctx,
  };
}

/**
 * Classify drag-drop observations.
 * Priority order: dragover_no_preventDefault > drop_silent_no_op > mime_misinterpretation
 */
export function classifyDragDrop(input: DragDropInput): BugDetection | null {
  const { observation } = input;

  if (!observation.dragoverDefaultPrevented) {
    return buildDetection('dragover_no_preventDefault', input);
  }

  // Silent no-op: drop occurred, DOM unchanged, and no console errors
  if (observation.dropOccurred && !observation.domOrderChanged && observation.consoleErrorsDelta === 0) {
    return buildDetection('drop_silent_no_op', input);
  }

  if (observation.mimeInterpretationFailed === true) {
    return buildDetection('mime_misinterpretation', input);
  }

  return null;
}
