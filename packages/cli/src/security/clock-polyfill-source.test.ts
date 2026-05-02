import { describe, it, expect } from 'vitest';
import { buildClockPolyfill, CLOCK_POLYFILL_TEMPLATE } from './clock-polyfill-source.js';

describe('clock-polyfill-source', () => {
  it('template contains __BUGHUNTER_CLOCK_INSTALLED sentinel', () => {
    expect(CLOCK_POLYFILL_TEMPLATE).toContain('__BUGHUNTER_CLOCK_INSTALLED');
  });

  it('template contains __BUGHUNTER_CLOCK_MS__ placeholder', () => {
    expect(CLOCK_POLYFILL_TEMPLATE).toContain('__BUGHUNTER_CLOCK_MS__');
  });

  it('buildClockPolyfill replaces placeholder with the given unix-ms', () => {
    const script = buildClockPolyfill(1_700_000_000_000);
    expect(script).toContain('1700000000000');
    expect(script).not.toContain('__BUGHUNTER_CLOCK_MS__');
  });

  it('built polyfill still contains the sentinel', () => {
    const script = buildClockPolyfill(Date.UTC(2026, 2, 8, 6, 30, 0));
    expect(script).toContain('__BUGHUNTER_CLOCK_INSTALLED');
  });

  it('does not patch performance.now or Intl.DateTimeFormat', () => {
    const script = buildClockPolyfill(0);
    expect(script).not.toContain('performance');
    expect(script).not.toContain('Intl');
    expect(script).not.toContain('DateTimeFormat');
  });
});
