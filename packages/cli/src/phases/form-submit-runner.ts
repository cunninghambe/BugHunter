// Form fill-and-submit helper extracted from execute.ts (line-budget §8).
// Called by executeUiTestInner's `case 'submit':` branch and replay.ts.

import type { EvaluateResult } from '../adapters/browser-mcp.js';
import { log } from '../log.js';

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
 */
export async function runFormSubmit(
  scope: FormSubmitScope,
  formSelector: string,
  input: Record<string, unknown>,
): Promise<void> {
  const coerced: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    coerced[name] = String(value);
  }

  let result: EvaluateResult;
  try {
    result = await scope.evaluate(buildFillSubmitScript(formSelector, coerced));
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
 */
export function buildFillSubmitScript(
  formSelector: string,
  input: Record<string, string>,
): string {
  const fs = JSON.stringify(formSelector);
  const inp = JSON.stringify(input);
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

/** Returns true for plain objects (not arrays, not null). */
export function isStringKeyedRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
