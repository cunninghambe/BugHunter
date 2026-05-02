// Tests for the locale-stress phase orchestrator (§4.1).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BugDetection } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks — factories must be self-contained (vi.mock is hoisted)
// ---------------------------------------------------------------------------

vi.mock('../discovery/locale/variant-util.js', () => ({
  captureRectMap: vi.fn().mockResolvedValue({}),
  RESTORE_SCRIPT: '/* restore */',
}));
vi.mock('../discovery/locale/rtl.js', () => ({
  runRtlVariant: vi.fn(),
  RESTORE_SCRIPT: '/* restore */',
}));
vi.mock('../discovery/locale/long-string.js', () => ({
  runLongStringDeVariant: vi.fn(),
  runLongStringZhVariant: vi.fn(),
}));
vi.mock('../discovery/locale/ambiguous-date.js', () => ({
  runAmbiguousDateVariant: vi.fn(),
}));
vi.mock('../discovery/locale/currency.js', () => ({
  runCurrencyVariant: vi.fn(),
}));
vi.mock('../discovery/locale/pluralization.js', () => ({
  runPluralizationVariant: vi.fn(),
}));
vi.mock('../discovery/locale/timezone-display.js', () => ({
  runTimezoneDisplayVariant: vi.fn(),
}));
vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

// Import mocked modules to spy on them
import * as RtlMod from '../discovery/locale/rtl.js';
import * as LongStringMod from '../discovery/locale/long-string.js';
import * as AmbiguousDateMod from '../discovery/locale/ambiguous-date.js';
import * as CurrencyMod from '../discovery/locale/currency.js';
import * as PluralizationMod from '../discovery/locale/pluralization.js';
import * as TimezoneMod from '../discovery/locale/timezone-display.js';
import { runLocaleStress } from './locale-stress.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResult(detections: BugDetection[] = []): { detections: BugDetection[]; restored: boolean } {
  return { detections, restored: true };
}

function makeBrowser(): object {
  return { evaluate: vi.fn().mockResolvedValue({ value: {} }) };
}

function makeVisionBudget(budgetLeft: number): { tryConsume: () => boolean } {
  let remaining = budgetLeft;
  return {
    tryConsume() {
      if (remaining <= 0) return false;
      remaining--;
      return true;
    },
  };
}

type LocInput = Parameters<typeof runLocaleStress>[0];

function makeInput(overrides: Partial<LocInput> = {}): LocInput {
  return {
    url: 'http://localhost:3000/',
    domWalk: { selectors: [], forms: [], links: [] } as unknown as LocInput['domWalk'],
    ltrScreenshotPath: '/tmp/ltr.png',
    ltrRectMap: {},
    browser: makeBrowser() as unknown as LocInput['browser'],
    vision: {} as unknown as LocInput['vision'],
    visionBudget: makeVisionBudget(10) as unknown as LocInput['visionBudget'],
    runId: 'run-1',
    outDir: '/tmp',
    settleMs: 0,
    ...overrides,
  };
}

function makeDetection(kind: BugDetection['kind']): BugDetection {
  return { kind, rootCause: 'test' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLocaleStress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(RtlMod.runRtlVariant).mockResolvedValue(makeOkResult() as ReturnType<typeof RtlMod.runRtlVariant> extends Promise<infer R> ? R : never);
    vi.mocked(LongStringMod.runLongStringDeVariant).mockResolvedValue(makeOkResult());
    vi.mocked(LongStringMod.runLongStringZhVariant).mockResolvedValue(makeOkResult());
    vi.mocked(AmbiguousDateMod.runAmbiguousDateVariant).mockResolvedValue(makeOkResult());
    vi.mocked(CurrencyMod.runCurrencyVariant).mockResolvedValue(makeOkResult());
    vi.mocked(PluralizationMod.runPluralizationVariant).mockResolvedValue(makeOkResult());
    vi.mocked(TimezoneMod.runTimezoneDisplayVariant).mockResolvedValue(makeOkResult());
  });

  it('runs all 6 variants when budget is sufficient', async () => {
    const result = await runLocaleStress(makeInput());
    expect(result.variantsRun).toContain('ltr_baseline');
    expect(result.variantsRun).toContain('rtl');
    expect(result.variantsRun).toContain('long_string_de');
    expect(result.variantsRun).toContain('long_string_zh');
    expect(result.variantsRun).toContain('ambiguous_date');
    expect(result.variantsRun).toContain('currency_jpy_bhd');
    expect(result.variantsRun).toContain('pluralization_n0_n1_nmany');
    expect(result.skippedReasons).toHaveLength(0);
  });

  it('collects detections from multiple variants', async () => {
    const rtlDet = makeDetection('i18n_rtl_layout_break');
    const longDet = makeDetection('i18n_long_string_overflow');
    vi.mocked(RtlMod.runRtlVariant).mockResolvedValue({ detections: [rtlDet], variantRectMap: {}, restored: true });
    vi.mocked(LongStringMod.runLongStringDeVariant).mockResolvedValue({ detections: [longDet], restored: true });

    const result = await runLocaleStress(makeInput());
    expect(result.detections).toContain(rtlDet);
    expect(result.detections).toContain(longDet);
  });

  it('skips variants when vision budget is exhausted', async () => {
    const input = makeInput({
      visionBudget: makeVisionBudget(2) as unknown as LocInput['visionBudget'],
    });
    const result = await runLocaleStress(input);
    const skipped = result.skippedReasons.filter(r => r.reason === 'vision_budget_exhausted');
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('stops remaining variants when restore fails', async () => {
    vi.mocked(RtlMod.runRtlVariant).mockResolvedValue({ detections: [], variantRectMap: {}, restored: false });

    const result = await runLocaleStress(makeInput());
    const restoreFailed = result.skippedReasons.filter(r => r.reason === 'restore_failed');
    expect(restoreFailed.length).toBeGreaterThan(0);
    expect(vi.mocked(LongStringMod.runLongStringDeVariant)).not.toHaveBeenCalled();
  });

  it('records a skipped reason when a variant throws', async () => {
    vi.mocked(RtlMod.runRtlVariant).mockRejectedValue(new Error('browser disconnected'));

    const result = await runLocaleStress(makeInput());
    const failed = result.skippedReasons.find(r => r.variant === 'rtl');
    expect(failed?.reason).toContain('browser disconnected');
  });

  it('returns url in output', async () => {
    const result = await runLocaleStress(makeInput({ url: 'http://localhost:3000/page' }));
    expect(result.url).toBe('http://localhost:3000/page');
  });

  it('always includes ltr_baseline in variantsRun even with zero budget', async () => {
    const result = await runLocaleStress(makeInput({
      visionBudget: makeVisionBudget(0) as unknown as LocInput['visionBudget'],
    }));
    expect(result.variantsRun).toContain('ltr_baseline');
  });

  it('runs timezone-display even after restore failure stops mutating variants', async () => {
    vi.mocked(RtlMod.runRtlVariant).mockResolvedValue({ detections: [], variantRectMap: {}, restored: false });
    const tzDet = makeDetection('i18n_timezone_display_wrong');
    vi.mocked(TimezoneMod.runTimezoneDisplayVariant).mockResolvedValue({ detections: [tzDet], restored: true });

    const result = await runLocaleStress(makeInput());
    expect(result.detections).toContain(tzDet);
  });
});
