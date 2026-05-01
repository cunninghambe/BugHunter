// Applies mutations to form data / API inputs.

import type { FormField, TestCase, DiscoveredForm, ToolMeta, PaletteVariant, InputType } from '../types.js';
import { generatePaletteCases } from './palette.js';
import { createId } from '../lib/ids.js';
import { generateCanaries } from '../security/injection-palette.js';
import type { CanaryPayload } from '../security/injection-palette.js';

type StateContext = NonNullable<TestCase['stateContext']>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Returns true for RFC 9110 safe methods (GET, HEAD, OPTIONS). Case-insensitive. */
export function isSafeMethod(method: string | undefined): boolean {
  return method !== undefined && SAFE_METHODS.has(method.toUpperCase());
}

const MUTATING_PALETTES = new Set<PaletteVariant>(['null', 'xss_inject', 'out_of_bounds']);

// Generate test cases for a form (fill-and-submit, 4 palette variants).
export function formTestCases(
  runId: string,
  role: string,
  page: string,
  form: DiscoveredForm,
  runIdForEmail: string,
  domainHints?: Record<string, string[]>,
  stateContext?: StateContext,
): TestCase[] {
  const formSig = formSignature(form);
  const palettes: PaletteVariant[] = ['null', 'happy', 'edge', 'out_of_bounds'];
  return palettes.map(palette => ({
    id: createId(),
    runId,
    role,
    page,
    formSignature: formSig,
    action: {
      kind: 'submit',
      via: 'ui',
      expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
      palette,
      selector: form.formSelector,
      input: buildFormInput(form.fields, palette, runIdForEmail, domainHints),
    },
    expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
    palette,
    stateContext,
  }));
}

// Generate direct API test cases for a tool.
// 'unknown'/'partial' confidence → one happy-path call only (per §3.4.1 and §8).
export function apiTestCases(
  runId: string,
  role: string,
  tool: ToolMeta,
  samples: unknown[],
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>
): TestCase[] {
  if (tool.inputSchemaConfidence === 'unknown' || tool.inputSchemaConfidence === 'partial') {
    const base = samples[0] ?? {};
    const input = bodyFixture !== undefined ? { ...base as Record<string, unknown>, ...bodyFixture } : base;
    return [{
      id: createId(),
      runId,
      role,
      page: tool.path,
      action: {
        kind: 'api_call',
        via: 'api',
        expectedOutcome: 'unknown',
        palette: 'happy',
        toolId: tool.toolId,
        input,
      },
      expectedOutcome: 'unknown',
      palette: 'happy',
    }];
  }

  const allPalettes: PaletteVariant[] = ['null', 'happy', 'edge', 'out_of_bounds'];
  const palettes = isSafeMethod(tool.method)
    ? allPalettes.filter(p => !MUTATING_PALETTES.has(p))
    : allPalettes;
  return palettes.map(palette => ({
    id: createId(),
    runId,
    role,
    page: tool.path,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
      palette,
      toolId: tool.toolId,
      input: buildApiInput(tool, palette, samples[0], domainHints, bodyFixture),
    },
    expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
    palette,
  }));
}

function buildFormInput(
  fields: FormField[],
  palette: PaletteVariant,
  runId: string,
  domainHints?: Record<string, string[]>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const cases = generatePaletteCases(field.type, runId, field, undefined, domainHints);
    const match = cases.find(c => c.variant === palette) ?? cases.find(c => c.variant === 'happy');
    if (match !== undefined) result[field.name] = match.value;
  }
  return result;
}

export function buildApiInput(
  tool: ToolMeta,
  palette: PaletteVariant,
  sampleInput: unknown,
  domainHints?: Record<string, string[]>,
  bodyFixture?: Record<string, unknown>
): unknown {
  if (tool.inputSchema.properties === undefined) return sampleInput ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    const inputType = schemaToInputType(schema);
    const dummyField: FormField = {
      name: key,
      type: inputType,
      required: tool.inputSchema.required?.includes(key) ?? false,
      options: Array.isArray(schema.enum) ? (schema.enum as string[]) : undefined,
      min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
      minLength: typeof schema.minLength === 'number' ? schema.minLength : undefined,
      maxLength: typeof schema.maxLength === 'number' ? schema.maxLength : undefined,
    };
    const sampleVal = typeof sampleInput === 'object' && sampleInput !== null
      ? (sampleInput as Record<string, unknown>)[key]
      : undefined;
    const cases = generatePaletteCases(inputType, key, dummyField, sampleVal, domainHints);
    const match = cases.find(c => c.variant === palette) ?? cases.find(c => c.variant === 'happy');
    if (match !== undefined) result[key] = match.value;
  }
  // Shallow-merge fixture onto happy-palette only; fixture keys win
  if (palette === 'happy' && bodyFixture !== undefined) {
    return { ...result, ...bodyFixture };
  }
  return result;
}

function schemaToInputType(schema: { type?: string; format?: string }): InputType {
  if (schema.format === 'email') return 'email';
  if (schema.format === 'uri' || schema.format === 'url') return 'url';
  if (schema.format === 'date' || schema.format === 'date-time') return 'date';
  if (schema.format === 'binary') return 'file';
  if (schema.format === 'color') return 'color';
  if (schema.format === 'password') return 'password';
  if (schema.format === 'tel') return 'tel';
  if (schema.format === 'slug') return 'slug';
  if (schema.format === 'foreign_id') return 'foreign_id';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return 'array';
  return 'text';
}

export function formSignature(form: DiscoveredForm): string {
  return form.fields.map(f => `${f.name}:${f.type}`).join(',');
}

/**
 * Generate XSS canary test cases for a form.
 * One test case per text-injectable field per canary variant.
 * Returns empty array when form has no injectable fields.
 */
export function xssFormTestCases(
  runId: string,
  role: string,
  page: string,
  form: DiscoveredForm,
  depth: 'minimal' | 'full' = 'minimal',
  stateContext?: StateContext,
): TestCase[] {
  const textFields = form.fields.filter(f => isTextInjectable(f.type));
  if (textFields.length === 0) return [];

  const canaries = generateCanaries(depth);
  const formSig = formSignature(form);
  const results: TestCase[] = [];

  for (const field of textFields) {
    for (const canary of canaries) {
      results.push(mintCanaryFormCase(runId, role, page, form, formSig, field, canary, stateContext));
    }
  }

  return results;
}

/**
 * Generate XSS canary test cases for an API tool.
 * One test case per string field per canary variant.
 * Returns empty array when tool has no injectable fields.
 */
export function xssApiTestCases(
  runId: string,
  role: string,
  tool: ToolMeta,
  depth: 'minimal' | 'full' = 'minimal',
  mutateJsonBodies = true,
): TestCase[] {
  if (tool.inputSchema.properties === undefined) return [];
  if (!mutateJsonBodies) return [];
  if (isSafeMethod(tool.method)) return [];

  const stringFields = Object.entries(tool.inputSchema.properties)
    .filter(([, schema]) => schema.type === 'string' || schema.type === undefined)
    .map(([key]) => key);

  if (stringFields.length === 0) return [];

  const canaries = generateCanaries(depth);
  const results: TestCase[] = [];

  for (const fieldName of stringFields) {
    for (const canary of canaries) {
      results.push(mintCanaryApiCase(runId, role, tool, fieldName, canary));
    }
  }

  return results;
}

function mintCanaryFormCase(
  runId: string,
  role: string,
  page: string,
  form: DiscoveredForm,
  formSig: string,
  field: FormField,
  canary: CanaryPayload,
  stateContext?: StateContext,
): TestCase {
  const input: Record<string, unknown> = {};
  for (const f of form.fields) {
    input[f.name] = f.name === field.name ? canary.value : '';
  }
  return {
    id: createId(),
    runId,
    role,
    page,
    formSignature: formSig,
    action: {
      kind: 'submit',
      via: 'ui',
      expectedOutcome: 'expected_failure',
      palette: 'xss_inject',
      selector: form.formSelector,
      input,
      injectionNonce: canary.nonce,
    },
    expectedOutcome: 'expected_failure',
    palette: 'xss_inject',
    stateContext,
  };
}

function mintCanaryApiCase(
  runId: string,
  role: string,
  tool: ToolMeta,
  fieldName: string,
  canary: CanaryPayload,
): TestCase {
  const input: Record<string, unknown> = { [fieldName]: canary.value };
  return {
    id: createId(),
    runId,
    role,
    page: tool.path,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'expected_failure',
      palette: 'xss_inject',
      toolId: tool.toolId,
      input,
      injectionNonce: canary.nonce,
    },
    expectedOutcome: 'expected_failure',
    palette: 'xss_inject',
  };
}

/** Returns true for InputTypes that can receive arbitrary text injection. */
function isTextInjectable(type: InputType): boolean {
  return type === 'text' || type === 'email' || type === 'url' || type === 'tel' || type === 'slug';
}
