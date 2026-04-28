// Form fill-and-submit helper extracted from execute.ts (line-budget §8).
// Called by executeUiTestInner's `case 'submit':` branch and replay.ts.

import type { TypeResult, EvaluateResult } from '../adapters/browser-mcp.js';

/** Minimal browser interface required by runFormSubmit. */
type FormSubmitScope = {
  type(selector: string, text: string): Promise<TypeResult>;
  evaluate(script: string): Promise<EvaluateResult>;
};

/**
 * Fill every named field in the form, then submit via a single browser-side
 * evaluate that resolves the submit button deterministically:
 *   button[type="submit"] → button (implicit) → requestSubmit() → native submit().
 *
 * NOTE: `input` values that are objects or arrays are coerced via String() —
 * this is a known wart of the planner's `buildFormInput` for `array` field
 * types and is out of scope for v0.9.
 */
export async function runFormSubmit(
  scope: FormSubmitScope,
  formSelector: string,
  input: Record<string, unknown>,
): Promise<void> {
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const fieldSelector = `${formSelector} [name="${cssEscape(name)}"]`;
    await scope.type(fieldSelector, String(value));
  }

  const result = await scope.evaluate(buildSubmitScript(formSelector));
  const v = result.value as { ok?: boolean; reason?: string } | undefined;
  if (v?.ok !== true) {
    throw new Error(`submit: ${v?.reason ?? 'unknown'} (formSelector=${formSelector})`);
  }
}

export function buildSubmitScript(formSelector: string): string {
  const fs = JSON.stringify(formSelector);
  return `((formSelector) => {
    const f = document.querySelector(formSelector);
    if (f === null) return { ok: false, reason: 'form_not_found' };
    const btn =
      f.querySelector('button[type="submit"], input[type="submit"]') ??
      f.querySelector('button:not([type="button"])');
    if (btn !== null) { btn.click(); return { ok: true, via: 'button' }; }
    if (typeof f.requestSubmit === 'function') { f.requestSubmit(); return { ok: true, via: 'requestSubmit' }; }
    f.submit(); return { ok: true, via: 'submit_native' };
  })(${fs})`;
}

/** Returns true for plain objects (not arrays, not null). */
export function isStringKeyedRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Minimal CSS attribute-selector escape for use inside `[name="..."]`.
 * Field names come from HTML `name` attributes; this handles the most common
 * special chars (backslash and double-quote) that would break the selector.
 */
function cssEscape(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
