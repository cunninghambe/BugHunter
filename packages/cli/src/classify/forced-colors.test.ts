import { describe, it, expect } from 'vitest';
import { classifyForcedColors } from './forced-colors.js';
import type { ForcedColorsInput } from './forced-colors.js';

function makeInput(overrides: Partial<ForcedColorsInput['observation']> & {
  envVisionThreshold?: number;
} = {}): ForcedColorsInput {
  const { envVisionThreshold = 0.18, ...obsOverrides } = overrides;
  return {
    pageRoute: '/settings',
    envVisionThreshold,
    observation: {
      visionDiffScore: 0,
      focusIndicatorInvisible: false,
      backgroundImageIconInvisible: false,
      domClipDetected: false,
      ...obsOverrides,
    },
  };
}

describe('classifyForcedColors', () => {
  it('returns null when forced-colors renders without layout breakage', () => {
    expect(classifyForcedColors(makeInput())).toBeNull();
  });

  it('detects focus_indicator_invisible', () => {
    const result = classifyForcedColors(makeInput({ focusIndicatorInvisible: true }));
    expect(result?.kind).toBe('forced_colors_failure');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('focus_indicator_invisible');
    }
  });

  it('detects background_image_icon_invisible', () => {
    const result = classifyForcedColors(makeInput({ backgroundImageIconInvisible: true }));
    expect(result?.kind).toBe('forced_colors_failure');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('background_image_icon_invisible');
    }
  });

  it('detects forced_colors_layout_clip from DOM-clip scan', () => {
    const result = classifyForcedColors(makeInput({ domClipDetected: true }));
    expect(result?.kind).toBe('forced_colors_failure');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('forced_colors_layout_clip');
    }
  });

  it('detects forced_colors_vision_diff when above threshold', () => {
    const result = classifyForcedColors(makeInput({ visionDiffScore: 0.25 }));
    expect(result?.kind).toBe('forced_colors_failure');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('forced_colors_vision_diff');
    }
  });

  it('does NOT fire vision_diff when below threshold', () => {
    const result = classifyForcedColors(makeInput({ visionDiffScore: 0.10 }));
    expect(result).toBeNull();
  });

  it('prioritizes focus_indicator over DOM-clip', () => {
    const result = classifyForcedColors(makeInput({
      focusIndicatorInvisible: true,
      domClipDetected: true,
    }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('focus_indicator_invisible');
    }
  });

  it('sets mediaQuery to forced-colors: active', () => {
    const result = classifyForcedColors(makeInput({ focusIndicatorInvisible: true }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.mediaQuery).toBe('forced-colors: active');
    }
  });
});
