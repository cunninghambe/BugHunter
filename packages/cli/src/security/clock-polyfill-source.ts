/**
 * v0.23 clock polyfill source — returned as a string for injection via
 * Page.addScriptToEvaluateOnNewDocument (or evaluate fallback).
 *
 * The polyfill patches globalThis.Date and Date.now so that new Date() / Date.now()
 * return times offset to the injected fakeNowMs. Explicit arguments (new Date('2024-02-29'))
 * are passed through to the real Date constructor unchanged.
 *
 * NOT patched (per spec §12):
 *   - performance.now / performance.timeOrigin (would corrupt perf measurements)
 *   - Intl.DateTimeFormat (TZ is handled by Emulation.setTimezoneOverride)
 *
 * Worker blind spot: init scripts run in the page realm only; dedicated workers and
 * service workers see the real clock. Document as a known limitation.
 *
 * Cross-origin iframes blind spot: addScriptToEvaluateOnNewDocument applies per-frame
 * for same-origin frames only. Cross-origin iframes (Stripe, Recaptcha) see real clock.
 */

/**
 * Build the polyfill script for a given target unix-ms.
 * The literal __BUGHUNTER_CLOCK_MS__ is replaced by the numeric value.
 * The sentinel __BUGHUNTER_CLOCK_INSTALLED = true is set so the runner can
 * detect whether the script ran before app code (CDP) or after (late-inject).
 */
export function buildClockPolyfill(fakeNowMs: number): string {
  // replaceAll: the placeholder appears at function-arg declaration, in the
  // offset calculation, and at the IIFE invocation site. .replace() (single
  // replace) leaves two occurrences and produces a runtime ReferenceError when
  // injected. Caught by clock-polyfill-source.test.ts.
  return CLOCK_POLYFILL_TEMPLATE.replaceAll('__BUGHUNTER_CLOCK_MS__', String(fakeNowMs));
}

/**
 * Template with the literal placeholder __BUGHUNTER_CLOCK_MS__.
 * Used by tests to verify sentinel presence without a concrete timestamp.
 */
export const CLOCK_POLYFILL_TEMPLATE = `(function(__BUGHUNTER_CLOCK_MS__){
  var RealDate = Date;
  var offset = __BUGHUNTER_CLOCK_MS__ - RealDate.now();
  function FakeDate() {
    if (arguments.length === 0) {
      return new RealDate(RealDate.now() + offset);
    }
    return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
  }
  FakeDate.now = function() { return RealDate.now() + offset; };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(FakeDate, RealDate);
  globalThis.Date = FakeDate;
  globalThis.__BUGHUNTER_CLOCK_INSTALLED = true;
})(__BUGHUNTER_CLOCK_MS__);`;
