// Form fill-and-submit helper extracted from execute.ts (line-budget §8).
// Called by executeUiTestInner's `case 'submit':` branch and replay.ts.

import type { EvaluateResult } from '../adapters/browser-mcp.js';
import { log } from '../log.js';
import { perfMs } from '../lib/perf.js';

/** Minimal browser interface required by runFormSubmit. */
type FormSubmitScope = {
  evaluate(script: string): Promise<EvaluateResult>;
};

/**
 * Fill every named field in the form and submit — all in a single
 * scope.evaluate round-trip, bypassing the camofox a11y-snapshot lookup
 * that fails for compound CSS selectors against unnamed inputs (v0.10 fix).
 *
 * Values that are null/undefined are skipped. All other values are coerced
 * via String() before being injected into the page.
 *
 * asyncMaxWaitMs controls the in-page poll for the form element before filling.
 * When > 0 (default 2000), the page-side script polls every 100ms until the form
 * mounts or the deadline elapses. When <= 0, falls back to immediate querySelector
 * (legacy behaviour, returns 'form_not_found' reason on miss).
 */
export async function runFormSubmit(
  scope: FormSubmitScope,
  formSelector: string,
  input: Record<string, unknown>,
  opts?: { asyncMaxWaitMs?: number; fillOnly?: boolean },
): Promise<void> {
  const asyncMaxWaitMs = opts?.asyncMaxWaitMs ?? 2000;
  const coerced: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    coerced[name] = String(value);
  }

  // v0.22: fillOnly mode — fill fields but do not submit. Used as nav-state seed
  // for back-after-form-fill to test whether the browser preserves filled inputs
  // when the user navigates away and returns (§5, §3.1).
  const fillScript = opts?.fillOnly === true
    ? buildFillOnlyScript(formSelector, coerced, asyncMaxWaitMs)
    : buildFillSubmitScript(formSelector, coerced, asyncMaxWaitMs);

  let result: EvaluateResult;
  try {
    result = await scope.evaluate(fillScript);
  } catch (err) {
    throw new Error(`submit: page_eval_threw: ${String(err)}`);
  }

  if (result.value === undefined) {
    throw new Error(`submit: no_result (formSelector=${formSelector})`);
  }

  const v = result.value as
    | { ok?: boolean; reason?: string; via?: string; field?: string; missingFields?: string[] }
    | undefined;

  if (v?.ok !== true) {
    const reason = v?.reason ?? 'unknown';
    const fieldSuffix = reason === 'file_field_unsettable' && v?.field !== undefined
      ? ` (field=${v.field})`
      : '';
    throw new Error(`submit: ${reason} (formSelector=${formSelector})${fieldSuffix}`);
  }

  if (v.missingFields !== undefined && v.missingFields.length > 0) {
    log.warn('runFormSubmit: missing fields skipped', { formSelector, missingFields: v.missingFields });
  }
}

/**
 * Builds an IIFE that fills each named field in the form and submits it.
 * Uses native value-setter pattern so React controlled inputs fire onChange.
 * formSelector and input are JSON-stringified — no string concatenation at
 * the host/page boundary.
 *
 * When asyncMaxWaitMs > 0, the IIFE polls document.querySelector every 100ms
 * until the form appears or the deadline elapses, returning
 * { ok: false, reason: 'form_never_rendered' } on timeout. When asyncMaxWaitMs
 * <= 0 the legacy immediate-check path is used (returns 'form_not_found').
 */
export function buildFillSubmitScript(
  formSelector: string,
  input: Record<string, string>,
  asyncMaxWaitMs = 2000,
): string {
  const fs = JSON.stringify(formSelector);
  const inp = JSON.stringify(input);

  if (asyncMaxWaitMs <= 0) {
    return buildImmediateScript(fs, inp);
  }
  return buildPolledScript(fs, inp, asyncMaxWaitMs);
}

function buildImmediateScript(fs: string, inp: string): string {
  return `(() => {
  const f = document.querySelector(${fs});
  if (f === null) return { ok: false, reason: 'form_not_found' };
  const inputMap = ${inp};
  const missingFields = [];
  for (const [name, value] of Object.entries(inputMap)) {
    const el = f.querySelector('[name=' + JSON.stringify(name) + ']');
    if (el === null) { missingFields.push(name); continue; }
    if (el.type === 'file') return { ok: false, reason: 'file_field_unsettable', field: name };
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = Boolean(value) && value !== 'false' && value !== '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const btn =
    f.querySelector('button[type="submit"], input[type="submit"]') ??
    f.querySelector('button:not([type="button"])');
  if (btn !== null) { btn.click(); return { ok: true, via: 'button', missingFields }; }
  if (typeof f.requestSubmit === 'function') { f.requestSubmit(); return { ok: true, via: 'requestSubmit', missingFields }; }
  try { f.submit(); return { ok: true, via: 'submit_native', missingFields }; }
  catch { return { ok: false, reason: 'submit_failed', via: 'submit_native' }; }
})()`;
}

/**
 * Builds an in-page IIFE that polls for the form every ~100ms until it appears
 * or `asyncMaxWaitMs` elapses, then fills each field and submits.
 * Runs synchronously inside a single CDP evaluate call — blocking the page's
 * JS thread is acceptable here because the form either renders within the budget
 * or is structurally absent (e.g. anon role, no session).
 */
function buildPolledScript(fs: string, inp: string, asyncMaxWaitMs: number): string {
  return `(() => {
  const deadline = Date.now() + ${asyncMaxWaitMs};
  let f = document.querySelector(${fs});
  while (f === null && Date.now() < deadline) {
    const end = Date.now() + 100;
    while (Date.now() < end) { /* busy-wait 100ms */ }
    f = document.querySelector(${fs});
  }
  if (f === null) return { ok: false, reason: 'form_never_rendered' };
  const inputMap = ${inp};
  const missingFields = [];
  for (const [name, value] of Object.entries(inputMap)) {
    const el = f.querySelector('[name=' + JSON.stringify(name) + ']');
    if (el === null) { missingFields.push(name); continue; }
    if (el.type === 'file') return { ok: false, reason: 'file_field_unsettable', field: name };
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = Boolean(value) && value !== 'false' && value !== '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const btn =
    f.querySelector('button[type="submit"], input[type="submit"]') ??
    f.querySelector('button:not([type="button"])');
  if (btn !== null) { btn.click(); return { ok: true, via: 'button', missingFields }; }
  if (typeof f.requestSubmit === 'function') { f.requestSubmit(); return { ok: true, via: 'requestSubmit', missingFields }; }
  try { f.submit(); return { ok: true, via: 'submit_native', missingFields }; }
  catch { return { ok: false, reason: 'submit_failed', via: 'submit_native' }; }
})()`;
}

/**
 * v0.22: fill-only script — fills all named fields but does NOT submit.
 * Used as the seed for back-after-form-fill nav-state tests (§5).
 */
export function buildFillOnlyScript(
  formSelector: string,
  input: Record<string, string>,
  asyncMaxWaitMs = 2000,
): string {
  const fs = JSON.stringify(formSelector);
  const inp = JSON.stringify(input);
  if (asyncMaxWaitMs <= 0) {
    return `(() => {
  const f = document.querySelector(${fs});
  if (f === null) return { ok: false, reason: 'form_not_found' };
  const inputMap = ${inp};
  const missingFields = [];
  for (const [name, value] of Object.entries(inputMap)) {
    const el = f.querySelector('[name=' + JSON.stringify(name) + ']');
    if (el === null) { missingFields.push(name); continue; }
    if (el.type === 'file') return { ok: false, reason: 'file_field_unsettable', field: name };
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = Boolean(value) && value !== 'false' && value !== '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return { ok: true, via: 'fill_only', missingFields };
})()`;
  }
  return `(() => {
  const deadline = Date.now() + ${asyncMaxWaitMs};
  let f = document.querySelector(${fs});
  while (f === null && Date.now() < deadline) {
    const end = Date.now() + 100;
    while (Date.now() < end) { /* busy-wait 100ms */ }
    f = document.querySelector(${fs});
  }
  if (f === null) return { ok: false, reason: 'form_never_rendered' };
  const inputMap = ${inp};
  const missingFields = [];
  for (const [name, value] of Object.entries(inputMap)) {
    const el = f.querySelector('[name=' + JSON.stringify(name) + ']');
    if (el === null) { missingFields.push(name); continue; }
    if (el.type === 'file') return { ok: false, reason: 'file_field_unsettable', field: name };
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = Boolean(value) && value !== 'false' && value !== '0';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA') {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  return { ok: true, via: 'fill_only', missingFields };
})()`;
}

/**
 * Polls the page for `formSelector` via a single evaluate call.
 * Returns whether the form was present, and the latency from call start to detection.
 * Used by both the form-reachability probe and execute state re-establishment.
 */
export async function waitForFormPresent(
  scope: FormSubmitScope,
  formSelector: string,
  asyncMaxWaitMs: number,
): Promise<{ present: boolean; latencyMs: number }> {
  const start = perfMs();
  const fs = JSON.stringify(formSelector);
  const script = `(() => {
  const deadline = Date.now() + ${asyncMaxWaitMs};
  let f = document.querySelector(${fs});
  while (f === null && Date.now() < deadline) {
    const end = Date.now() + 100;
    while (Date.now() < end) { /* busy-wait 100ms */ }
    f = document.querySelector(${fs});
  }
  return f !== null;
})()`;
  const result = await scope.evaluate(script);
  const latencyMs = perfMs() - start;
  return { present: result.value === true, latencyMs };
}

/** Returns true for plain objects (not arrays, not null). */
export function isStringKeyedRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
