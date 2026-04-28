// Mutation palette per input type (§ 3.4.2).
// Generates the four test variants: null, happy, edge, out_of_bounds.

import type { InputType, PaletteVariant, FormField } from '../types.js';

export type MutationCase = {
  variant: PaletteVariant;
  value: unknown;
};

type NumberSchema = { minimum?: number; maximum?: number };
type TextSchema = { minLength?: number; maxLength?: number };
type RangeSchema = { minimum?: number; maximum?: number };

// Generates all 4 palette cases for a given input type.
// sampleValue: from surface_sample_inputs or domainHints (for slug/foreign_id).
export function generatePaletteCases(
  type: InputType,
  runId: string,
  field: FormField,
  sampleValue?: unknown,
  domainHints?: Record<string, string[]>
): MutationCase[] {
  switch (type) {
    case 'text': return textCases(field as TextSchema, sampleValue);
    case 'email': return emailCases(runId);
    case 'number': return numberCases(field as NumberSchema, sampleValue);
    case 'date': return dateCases();
    case 'select': return selectCases(field.options);
    case 'checkbox': return checkboxCases();
    case 'file': return fileCases(field as { min?: number; max?: number });
    case 'boolean': return booleanCases();
    case 'array': return arrayCases(sampleValue);
    case 'tel': return telCases();
    case 'url': return urlCases();
    case 'password': return passwordCases(field as TextSchema);
    case 'color': return colorCases();
    case 'range': return rangeCases(field as RangeSchema);
    case 'slug': return slugCases(sampleValue, domainHints);
    case 'foreign_id': return foreignIdCases(sampleValue, domainHints);
  }
}

function textCases(schema: TextSchema, sampleValue?: unknown): MutationCase[] {
  const maxLen = schema.maxLength ?? 255;
  const edgeStr = 'a'.repeat(maxLen);
  const oobStr = 'a'.repeat(maxLen + 1);
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: sampleValue ?? 'test value' },
    { variant: 'edge', value: edgeStr },
    { variant: 'out_of_bounds', value: oobStr },
    // XSS attempt as second out_of_bounds variant — still tagged out_of_bounds
    { variant: 'out_of_bounds', value: '<script>alert(1)</script>' },
  ];
}

function emailCases(runId: string): MutationCase[] {
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: `bughunter+${runId}@test.local` },
    { variant: 'edge', value: `${'a'.repeat(64)}@test.local` },
    { variant: 'out_of_bounds', value: 'not-an-email' },
  ];
}

function numberCases(schema: NumberSchema, sampleValue?: unknown): MutationCase[] {
  const minimum = schema.minimum;
  const maximum = schema.maximum;
  return [
    { variant: 'null', value: undefined },
    { variant: 'happy', value: sampleValue ?? 1 },
    { variant: 'edge', value: minimum ?? 0 },
    { variant: 'edge', value: maximum ?? 0 },
    { variant: 'out_of_bounds', value: Number.MAX_SAFE_INTEGER + 1 },
    { variant: 'out_of_bounds', value: NaN },
  ];
}

function dateCases(): MutationCase[] {
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: new Date().toISOString().slice(0, 10) },
    { variant: 'edge', value: '1900-01-01' },
    { variant: 'edge', value: '2100-12-31' },
    { variant: 'out_of_bounds', value: 'not-a-date' },
  ];
}

function selectCases(options?: string[]): MutationCase[] {
  const first = options?.[0] ?? '';
  const last = options?.[options.length - 1] ?? '';
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: first },
    { variant: 'edge', value: last },
    { variant: 'out_of_bounds', value: '__bughunter_unlisted_value__' },
  ];
}

function checkboxCases(): MutationCase[] {
  return [
    { variant: 'null', value: false },
    { variant: 'happy', value: true },
  ];
}

function fileCases(schema: { min?: number; max?: number }): MutationCase[] {
  const maxBytes = schema.max ?? 10 * 1024 * 1024; // 10 MB default
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: { mimeType: 'image/jpeg', sizeBytes: 1024, name: 'test.jpg' } },
    { variant: 'edge', value: { mimeType: 'image/jpeg', sizeBytes: maxBytes, name: 'at-limit.jpg' } },
    { variant: 'out_of_bounds', value: { mimeType: 'application/x-msdownload', sizeBytes: maxBytes + 1, name: 'test.exe' } },
  ];
}

function booleanCases(): MutationCase[] {
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: true },
    { variant: 'out_of_bounds', value: false },
  ];
}

function arrayCases(sampleValue?: unknown): MutationCase[] {
  const oneItem = Array.isArray(sampleValue) && sampleValue.length > 0
    ? [sampleValue[0]]
    : ['item1'];
  const allItems = Array.isArray(sampleValue) ? sampleValue : ['item1', 'item2'];
  return [
    { variant: 'null', value: [] },
    { variant: 'happy', value: oneItem },
    { variant: 'edge', value: allItems },
    { variant: 'out_of_bounds', value: ['__bughunter_nonexistent__'] },
  ];
}

function telCases(): MutationCase[] {
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: '+15555550100' },
    { variant: 'edge', value: `+1${  '5'.repeat(13)}` }, // format-extreme valid
    { variant: 'out_of_bounds', value: 'not-a-phone-number!!@#' },
  ];
}

function urlCases(): MutationCase[] {
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: 'https://test.local/x' },
    { variant: 'edge', value: `https://${  'a'.repeat(2000)}` },
    { variant: 'out_of_bounds', value: 'not-a-url' },
    { variant: 'out_of_bounds', value: 'hxtp://malformed.scheme' },
  ];
}

function passwordCases(schema: TextSchema): MutationCase[] {
  const minLen = schema.minLength ?? 8;
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: `T3st!P@ss${  'x'.repeat(Math.max(0, minLen - 9))}` },
    { variant: 'edge', value: 'a'.repeat(minLen) },
    { variant: 'out_of_bounds', value: 'a'.repeat(10_000) },
  ];
}

function colorCases(): MutationCase[] {
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: '#000000' },
    { variant: 'edge', value: '#ffffff' },
    { variant: 'out_of_bounds', value: 'red' },
    { variant: 'out_of_bounds', value: '#GGGGGG' },
  ];
}

function rangeCases(schema: RangeSchema): MutationCase[] {
  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? 100;
  const mid = Math.floor((min + max) / 2);
  return [
    { variant: 'null', value: min },
    { variant: 'happy', value: mid },
    { variant: 'edge', value: min },
    { variant: 'edge', value: max },
    { variant: 'out_of_bounds', value: min - 1 },
    { variant: 'out_of_bounds', value: max + 1 },
  ];
}

function slugCases(sampleValue?: unknown, domainHints?: Record<string, string[]>): MutationCase[] {
  const happy = domainHints?.['slug']?.[0] ?? sampleValue ?? 'sample-slug';
  const hyphenHeavy = '-a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-';
  const maxLength = 'a'.repeat(255);
  return [
    { variant: 'null', value: '' },
    { variant: 'happy', value: happy },
    { variant: 'edge', value: hyphenHeavy },
    { variant: 'edge', value: maxLength },
    { variant: 'out_of_bounds', value: 'slug with spaces' },
    { variant: 'out_of_bounds', value: 'slug#special!chars' },
  ];
}

function foreignIdCases(sampleValue?: unknown, domainHints?: Record<string, string[]>): MutationCase[] {
  const happy = domainHints?.['foreign_id']?.[0] ?? sampleValue;
  if (happy === undefined) {
    return [
      { variant: 'null', value: null },
      { variant: 'out_of_bounds', value: 99_999_999 },
      { variant: 'out_of_bounds', value: 'string-instead-of-int' },
    ];
  }
  const isNumeric = typeof happy === 'number';
  return [
    { variant: 'null', value: null },
    { variant: 'happy', value: happy },
    { variant: 'edge', value: isNumeric ? (happy as number) + 999_999 : `${String(happy)}-nonexistent` },
    { variant: 'out_of_bounds', value: isNumeric ? `${String(happy)}-wrongtype` : 999_999 },
  ];
}
