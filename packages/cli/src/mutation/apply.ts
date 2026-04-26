// Applies mutations to form data / API inputs.

import type { FormField, TestCase, DiscoveredForm, ToolMeta, PaletteVariant } from '../types.js';
import { generatePaletteCases } from './palette.js';
import { createId } from '@paralleldrive/cuid2';

// Generate test cases for a form (fill-and-submit, 4 palette variants).
export function formTestCases(
  runId: string,
  role: string,
  page: string,
  form: DiscoveredForm,
  runIdForEmail: string,
  domainHints?: Record<string, string[]>
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
      input: buildFormInput(form.fields, palette, runIdForEmail, domainHints),
    },
    expectedOutcome: palette === 'happy' ? 'success' : 'expected_failure',
    palette,
  }));
}

// Generate 4 direct API test cases for a tool.
export function apiTestCases(
  runId: string,
  role: string,
  tool: ToolMeta,
  samples: unknown[],
  domainHints?: Record<string, string[]>
): TestCase[] {
  if (tool.inputSchemaConfidence === 'unknown') {
    // After failed probe: one happy-path call only
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
        input: samples[0] ?? {},
      },
      expectedOutcome: 'unknown',
      palette: 'happy',
    }];
  }

  const palettes: PaletteVariant[] = ['null', 'happy', 'edge', 'out_of_bounds'];
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
      input: buildApiInput(tool, palette, samples[0], domainHints),
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
    if (match) result[field.name] = match.value;
  }
  return result;
}

export function buildApiInput(
  tool: ToolMeta,
  palette: PaletteVariant,
  sampleInput: unknown,
  domainHints?: Record<string, string[]>
): unknown {
  if (!tool.inputSchema.properties) return sampleInput ?? {};
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
    if (match) result[key] = match.value;
  }
  return result;
}

function schemaToInputType(schema: { type?: string; format?: string }): import('../types.js').InputType {
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
