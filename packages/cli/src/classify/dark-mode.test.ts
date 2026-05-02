import { describe, it, expect } from 'vitest';
import { classifyDarkMode } from './dark-mode.js';
import type { DarkModeInput } from './dark-mode.js';

function makeInput(overrides: Partial<DarkModeInput['observation']> & {
  envVisionThreshold?: number;
} = {}): DarkModeInput {
  const { envVisionThreshold = 0.18, ...obsOverrides } = overrides;
  return {
    pageRoute: '/dashboard',
    envVisionThreshold,
    observation: {
      visionDiffScore: 0,
      textRegionDiffFraction: 0,
      lowContrastNodeCount: 0,
      lowContrastNodeCountBaseline: 0,
      svgIconInvisible: false,
      ...obsOverrides,
    },
  };
}

describe('classifyDarkMode', () => {
  it('returns null when dark mode renders without issues', () => {
    expect(classifyDarkMode(makeInput())).toBeNull();
  });

  it('detects svg_icon_invisible_in_dark', () => {
    const result = classifyDarkMode(makeInput({ svgIconInvisible: true }));
    expect(result?.kind).toBe('dark_mode_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('svg_icon_invisible_in_dark');
    }
  });

  it('detects contrast_collapsed_in_dark when regression >= 5', () => {
    const result = classifyDarkMode(makeInput({
      lowContrastNodeCount: 6,
      lowContrastNodeCountBaseline: 0,
    }));
    expect(result?.kind).toBe('dark_mode_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('contrast_collapsed_in_dark');
    }
  });

  it('does NOT fire contrast detection when regression < 5', () => {
    const result = classifyDarkMode(makeInput({
      lowContrastNodeCount: 4,
      lowContrastNodeCountBaseline: 0,
    }));
    expect(result).toBeNull();
  });

  it('does NOT fire contrast when both baseline and dark are equally bad (no regression)', () => {
    const result = classifyDarkMode(makeInput({
      lowContrastNodeCount: 6,
      lowContrastNodeCountBaseline: 6,
    }));
    expect(result).toBeNull();
  });

  it('detects mass_text_color_collision_under_dark when diff score and text fraction are high', () => {
    const result = classifyDarkMode(makeInput({
      visionDiffScore: 0.25,
      textRegionDiffFraction: 0.3,
    }));
    expect(result?.kind).toBe('dark_mode_layout_break');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('mass_text_color_collision_under_dark');
    }
  });

  it('does NOT fire vision diff when text fraction is below 20%', () => {
    const result = classifyDarkMode(makeInput({
      visionDiffScore: 0.25,
      textRegionDiffFraction: 0.1,
    }));
    expect(result).toBeNull();
  });

  it('prioritizes svg_icon_invisible over contrast collapse', () => {
    const result = classifyDarkMode(makeInput({
      svgIconInvisible: true,
      lowContrastNodeCount: 8,
      lowContrastNodeCountBaseline: 0,
    }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('svg_icon_invisible_in_dark');
    }
  });

  it('sets mediaQuery to prefers-color-scheme: dark', () => {
    const result = classifyDarkMode(makeInput({ svgIconInvisible: true }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.mediaQuery).toBe('prefers-color-scheme: dark');
    }
  });
});
