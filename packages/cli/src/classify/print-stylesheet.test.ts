import { describe, it, expect } from 'vitest';
import { classifyPrintStylesheet } from './print-stylesheet.js';
import type { PrintStylesheetInput } from './print-stylesheet.js';

function makeInput(overrides: Partial<PrintStylesheetInput['observation']> & {
  printStylesheetRequired?: boolean;
  envVisionThreshold?: number;
} = {}): PrintStylesheetInput {
  const { printStylesheetRequired = false, envVisionThreshold = 0.18, ...obsOverrides } = overrides;
  return {
    pageRoute: '/dashboard',
    printStylesheetRequired,
    envVisionThreshold,
    observation: {
      visionDiffScore: 0,
      visionDiffCoverage: 0,
      horizontalOverflow: false,
      contentHidden: false,
      noPrintStylesheet: false,
      visibleContentLength: 1000,
      ...obsOverrides,
    },
  };
}

describe('classifyPrintStylesheet', () => {
  it('returns null when print renders without issues', () => {
    expect(classifyPrintStylesheet(makeInput())).toBeNull();
  });

  it('detects print_content_hidden', () => {
    const result = classifyPrintStylesheet(makeInput({ contentHidden: true }));
    expect(result?.kind).toBe('print_stylesheet_broken');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('print_content_hidden');
    }
  });

  it('detects print_horizontal_overflow', () => {
    const result = classifyPrintStylesheet(makeInput({ horizontalOverflow: true }));
    expect(result?.kind).toBe('print_stylesheet_broken');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('print_horizontal_overflow');
    }
  });

  it('detects mass_layout_diff_in_print when diff score exceeds threshold and coverage > 30%', () => {
    const result = classifyPrintStylesheet(makeInput({
      visionDiffScore: 0.25,
      visionDiffCoverage: 0.5,
    }));
    expect(result?.kind).toBe('print_stylesheet_broken');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('mass_layout_diff_in_print');
    }
  });

  it('does NOT fire mass_layout_diff when coverage is below 30%', () => {
    const result = classifyPrintStylesheet(makeInput({
      visionDiffScore: 0.25,
      visionDiffCoverage: 0.2,
    }));
    expect(result).toBeNull();
  });

  it('detects no_print_stylesheet_defined when printStylesheetRequired is true', () => {
    const result = classifyPrintStylesheet(makeInput({
      noPrintStylesheet: true,
      printStylesheetRequired: true,
      visibleContentLength: 600,
    }));
    expect(result?.kind).toBe('print_stylesheet_broken');
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('no_print_stylesheet_defined');
    }
  });

  it('does NOT fire no_print_stylesheet when printStylesheetRequired is false (default)', () => {
    const result = classifyPrintStylesheet(makeInput({
      noPrintStylesheet: true,
      printStylesheetRequired: false,
    }));
    expect(result).toBeNull();
  });

  it('does NOT fire no_print_stylesheet when content is trivial (<= 500 chars)', () => {
    const result = classifyPrintStylesheet(makeInput({
      noPrintStylesheet: true,
      printStylesheetRequired: true,
      visibleContentLength: 400,
    }));
    expect(result).toBeNull();
  });

  it('prioritizes content_hidden over horizontal_overflow', () => {
    const result = classifyPrintStylesheet(makeInput({ contentHidden: true, horizontalOverflow: true }));
    if (result?.interactionContext?.kind === 'env') {
      expect(result.interactionContext.proof).toBe('print_content_hidden');
    }
  });
});
