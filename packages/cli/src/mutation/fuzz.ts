/**
 * v0.39 — Generative / property-based fuzz strategies.
 *
 * fast-check is quarantined to this module. Only fc.sample (deterministic draw)
 * is used — never fc.assert, fc.property, fc.statefulCommands, or fc.scheduler.
 * Every fc.sample call MUST pass { seed, numRuns }.
 *
 * Naughty-string curated list adapted from minimaxir/big-list-of-naughty-strings
 * (MIT License, https://github.com/minimaxir/big-list-of-naughty-strings).
 */

import * as fc from 'fast-check';
import type { FormField, ToolMeta, InputType } from '../types.js';

// --- Public types ---

export type FuzzStrategy = 'unicode' | 'shape' | 'boundary';

export type FuzzOptions = {
  strategies: FuzzStrategy[];
  runs: number;
  subSeedBase: number;
  shrink: boolean;
  maxTotalDraws: number;
};

export type MutationCase = {
  variant: 'fuzz';
  strategy: FuzzStrategy;
  drawIndex: number;
  subSeed: number;
  value: unknown;
};

// --- Seed derivation ---

/**
 * FNV-1a 32-bit hash mix. Combines runSeed with namespace + discriminator parts
 * to produce a deterministic sub-seed suitable for fast-check's seed parameter.
 */
export function deriveSubSeed(runSeed: number, namespace: string, ...parts: string[]): number {
  const str = [namespace, ...parts].join('\0');
  let hash = 2166136261; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (Math.imul(hash, 16777619) >>> 0); // FNV prime, force unsigned
  }
  // XOR-mix with runSeed so different runs produce different sequences
  return (hash ^ (runSeed >>> 0)) >>> 0;
}

// --- Curated naughty strings (MIT) ---

const NAUGHTY_STRINGS: readonly string[] = [
  // Unicode / RTL / bidi
  '‮',           // RIGHT-TO-LEFT OVERRIDE
  '‭',           // LEFT-TO-RIGHT OVERRIDE
  '​',           // ZERO WIDTH SPACE
  '‌',           // ZERO WIDTH NON-JOINER
  '‍',           // ZERO WIDTH JOINER
  '﻿',           // BOM / ZERO WIDTH NO-BREAK SPACE
  '⁠',           // WORD JOINER
  // Surrogate edges
  '𐀀',     // U+10000 LINEAR B SYLLABLE B008 A
  '􏿿',     // U+10FFFF
  // Control characters
  '\x00',
  '\x01',
  '\x1f',
  '\x7f',
  // Combining marks
  '̀́',
  // CJK / emoji
  '中文',
  '日本語',
  '한국어',
  '\u{1F600}',        // 😀
  '\u{1F4A9}',        // 💩
  // Special SQL / injection
  "' OR '1'='1",
  '<script>alert(1)</script>',
  '{{7*7}}',
  '../../../etc/passwd',
  // Long string (potential buffer edge)
  'a'.repeat(256),
  'a'.repeat(1024),
  // Null / empty
  '',
  ' ',
  '\n\r\t',
  // Numeric strings that look like numbers
  '9999999999999999999',
  'NaN',
  'Infinity',
];

// --- Unicode strategy ---

const MAX_UNICODE_LEN = 1024;
const MAX_API_STRING_LEN = 4096;

function unicodeArb(maxLen: number): fc.Arbitrary<string> {
  const generated = fc.unicodeString({ minLength: 1, maxLength: maxLen });
  const curated = fc.constantFrom(...NAUGHTY_STRINGS.map(s => s.slice(0, maxLen)));
  return fc.oneof({ weight: 3, arbitrary: generated }, { weight: 1, arbitrary: curated });
}

/**
 * Unicode fuzz for form fields (text/email/url/tel/slug/password).
 * Respects field.maxLength; clamps to MAX_UNICODE_LEN when unset.
 */
export function fuzzUnicode(
  type: InputType,
  field: FormField,
  subSeed: number,
  runs: number,
): MutationCase[] {
  const unicodeTypes: InputType[] = ['text', 'email', 'url', 'tel', 'slug', 'password'];
  if (!unicodeTypes.includes(type)) return [];

  const maxLen = field.maxLength ?? MAX_UNICODE_LEN;
  const arb = unicodeArb(maxLen);
  let samples: string[];
  try {
    samples = fc.sample(arb, { numRuns: runs, seed: subSeed });
  } catch {
    return [];
  }
  return samples.map((value, i) => ({
    variant: 'fuzz',
    strategy: 'unicode',
    drawIndex: i,
    subSeed,
    value,
  }));
}

/**
 * Unicode fuzz for a single string field in an API tool schema.
 * Clamps to MAX_API_STRING_LEN when no maxLength constraint is declared.
 */
export function fuzzUnicodeField(
  fieldName: string,
  schema: { maxLength?: number },
  subSeed: number,
  runs: number,
): MutationCase[] {
  const maxLen = schema.maxLength ?? MAX_API_STRING_LEN;
  const arb = unicodeArb(maxLen);
  let samples: string[];
  try {
    samples = fc.sample(arb, { numRuns: runs, seed: subSeed });
  } catch {
    return [];
  }
  return samples.map((value, i) => ({
    variant: 'fuzz',
    strategy: 'unicode',
    drawIndex: i,
    subSeed,
    value: { [fieldName]: value } as unknown,
  }));
}

// --- Shape strategy ---

type ShapeClass = 'drop_required' | 'reorder_keys' | 'type_substitute' | 'extra_key' | 'wrap_top_level';
const SHAPE_CLASSES: ShapeClass[] = ['drop_required', 'reorder_keys', 'type_substitute', 'extra_key', 'wrap_top_level'];

function buildBaseBody(tool: ToolMeta, sampleInput: unknown): Record<string, unknown> {
  if (tool.inputSchema.properties === undefined) return {};
  const base = (typeof sampleInput === 'object' && sampleInput !== null)
    ? (sampleInput as Record<string, unknown>)
    : {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(tool.inputSchema.properties)) {
    result[key] = key in base ? base[key] : null;
  }
  return result;
}

/**
 * Shape fuzz for API tools — mutates the top-level JSON body structure.
 * Skipped for safe methods (GET/HEAD/OPTIONS) — caller is responsible.
 * Returns empty array when schema has no properties.
 */
export function fuzzShape(
  tool: ToolMeta,
  sampleInput: unknown,
  subSeed: number,
  runs: number,
): MutationCase[] {
  if (tool.inputSchema.properties === undefined) return [];

  const base = buildBaseBody(tool, sampleInput);
  const required = tool.inputSchema.required ?? [];
  const keys = Object.keys(base);

  const results: MutationCase[] = [];
  // Round-robin across shape classes so each class gets at least one draw when runs ≥ 5
  for (let i = 0; i < runs; i++) {
    const cls = SHAPE_CLASSES[i % SHAPE_CLASSES.length];
    const classSeed = (subSeed + i * 31337) >>> 0;
    let mutated: unknown;
    try {
      mutated = applyShapeClass(cls, base, keys, required, classSeed);
    } catch {
      continue;
    }
    results.push({ variant: 'fuzz', strategy: 'shape', drawIndex: i, subSeed: classSeed, value: mutated });
  }
  return results;
}

function applyShapeClass(
  cls: ShapeClass,
  base: Record<string, unknown>,
  keys: string[],
  required: string[],
  seed: number,
): unknown {
  switch (cls) {
    case 'drop_required': {
      if (required.length === 0) return { ...base };
      const [picked] = fc.sample(fc.constantFrom(...required), { numRuns: 1, seed });
      const copy = { ...base };
      delete copy[picked];
      return copy;
    }
    case 'reorder_keys': {
      if (keys.length < 2) return { ...base };
      const permuted = fc.sample(fc.shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length }), { numRuns: 1, seed });
      const reordered: Record<string, unknown> = {};
      for (const k of permuted[0]) reordered[k] = base[k];
      return reordered;
    }
    case 'type_substitute': {
      if (keys.length === 0) return { ...base };
      const [fieldToSubstitute] = fc.sample(fc.constantFrom(...keys), { numRuns: 1, seed });
      const substituteArb = fc.oneof(
        fc.string(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.constant([]),
        fc.constant({}),
      );
      const [subVal] = fc.sample(substituteArb, { numRuns: 1, seed: (seed + 1) >>> 0 });
      return { ...base, [fieldToSubstitute]: subVal };
    }
    case 'extra_key': {
      const [randVal] = fc.sample(fc.string(), { numRuns: 1, seed });
      return { ...base, __bughunter_unknown_field: randVal };
    }
    case 'wrap_top_level': {
      const wrapArb = fc.constantFrom(
        { data: base },
        [base],
      ) as fc.Arbitrary<unknown>;
      const [wrapped] = fc.sample(wrapArb, { numRuns: 1, seed });
      return wrapped;
    }
  }
}

// --- Boundary strategy ---

/**
 * Boundary fuzz for form fields — tests declared min/max/minLength/maxLength/enum boundaries.
 */
export function fuzzBoundaryForForm(
  field: FormField,
  subSeed: number,
  runs: number,
): MutationCase[] {
  const candidates = buildFormBoundaryCandidates(field);
  if (candidates.length === 0) return [];
  return sampleFromCandidates(candidates, subSeed, runs, 'boundary');
}

function buildFormBoundaryCandidates(field: FormField): unknown[] {
  const candidates: unknown[] = [];

  if (field.options !== undefined && field.options.length > 0) {
    // enum: include valid + just-invalid values
    for (const opt of field.options) {
      candidates.push(opt, `${opt}_INVALID`, '__not_in_enum__', '');
    }
    return candidates; // enum wins over length constraints per EC-2
  }

  if (field.min !== undefined) {
    candidates.push(field.min - 1, field.min, field.min + 1, -field.min);
  }
  if (field.max !== undefined) {
    candidates.push(field.max - 1, field.max, field.max + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN);
  }
  if (field.minLength !== undefined) {
    candidates.push(
      'a'.repeat(Math.max(0, field.minLength - 1)),
      'a'.repeat(field.minLength),
      'a'.repeat(field.minLength + 1),
    );
  }
  if (field.maxLength !== undefined) {
    candidates.push(
      'a'.repeat(Math.max(0, field.maxLength - 1)),
      'a'.repeat(field.maxLength),
      'a'.repeat(field.maxLength + 1),
    );
  }

  return candidates;
}

/**
 * Boundary fuzz for API tools — tests JSON Schema constraints.
 */
export function fuzzBoundaryForTool(
  tool: ToolMeta,
  subSeed: number,
  runs: number,
): MutationCase[] {
  if (tool.inputSchema.properties === undefined) return [];

  const perFieldCandidates: Array<[string, unknown[]]> = [];
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    const candidates = buildSchemaBoundaryCandidates(schema, subSeed);
    if (candidates.length > 0) perFieldCandidates.push([key, candidates]);
  }

  if (perFieldCandidates.length === 0) return [];

  const results: MutationCase[] = [];
  for (let i = 0; i < runs; i++) {
    const [fieldName, candidates] = perFieldCandidates[i % perFieldCandidates.length];
    const candidate = candidates[i % candidates.length];
    results.push({
      variant: 'fuzz',
      strategy: 'boundary',
      drawIndex: i,
      subSeed: (subSeed + i * 7919) >>> 0,
      value: { [fieldName]: candidate },
    });
  }
  return results;
}

function buildSchemaBoundaryCandidates(
  schema: { type?: string; format?: string; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string },
  seed: number,
): unknown[] {
  const candidates: unknown[] = [];

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    for (const opt of schema.enum) {
      candidates.push(opt, `${String(opt)}_INVALID`, '__not_in_enum__', '');
    }
    return candidates;
  }

  if (schema.minimum !== undefined) {
    candidates.push(schema.minimum - 1, schema.minimum, schema.minimum + 1, -schema.minimum);
  }
  if (schema.maximum !== undefined) {
    candidates.push(schema.maximum - 1, schema.maximum, schema.maximum + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN);
  }
  if (schema.minLength !== undefined) {
    candidates.push(
      'a'.repeat(Math.max(0, schema.minLength - 1)),
      'a'.repeat(schema.minLength),
      'a'.repeat(schema.minLength + 1),
    );
  }
  if (schema.maxLength !== undefined) {
    candidates.push(
      'a'.repeat(Math.max(0, schema.maxLength - 1)),
      'a'.repeat(schema.maxLength),
      'a'.repeat(schema.maxLength + 1),
    );
  }

  if (schema.format !== undefined) {
    candidates.push(...formatBoundaryCandidates(schema.format));
  }

  if (schema.pattern !== undefined) {
    try {
      const matchingArb = fc.stringMatching(new RegExp(schema.pattern));
      const [matching] = fc.sample(matchingArb, { numRuns: 1, seed });
      candidates.push(matching, `${matching}INVALID`, '');
    } catch {
      // EC-3: pattern fast-check can't compile → fall back to near-misses
      candidates.push('', 'INVALID_PATTERN_VALUE');
    }
  }

  return candidates;
}

function formatBoundaryCandidates(format: string): unknown[] {
  switch (format) {
    case 'email': return ['not-an-email', '@nodomain', 'missing@', ''];
    case 'date': return ['2000-13-01', '2000-00-01', '9999-12-31', 'not-a-date'];
    case 'date-time': return ['2000-01-01T25:00:00Z', '2000-01-01', 'not-a-datetime'];
    case 'uri':
    case 'url': return ['not-a-url', 'http://', ''];
    case 'uuid': return [
      '00000000-0000-0000-0000-000000000000', // all-zero
      'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', // invalid hex
      '550e8400-e29b-41d4-a716', // truncated
      '',
    ];
    default: return [];
  }
}

function sampleFromCandidates(
  candidates: unknown[],
  subSeed: number,
  runs: number,
  strategy: FuzzStrategy,
): MutationCase[] {
  // Round-robin candidates to fill `runs` slots
  const cap = candidates.length > 0 ? candidates.length * 3 : runs;
  return Array.from({ length: Math.min(runs, cap) }, (_, i) => ({
    variant: 'fuzz' as const,
    strategy,
    drawIndex: i,
    subSeed: (subSeed + i * 1009) >>> 0,
    value: candidates[i % candidates.length],
  }));
}

// --- Shrink ---

type ShrinkParams = {
  strategy: FuzzStrategy;
  subSeed: number;
  drawIndex: number;
  originalValue: unknown;
};

/**
 * Attempt to shrink a failing fuzz value to a smaller reproduction.
 * Bounded to shrinkMaxSteps attempts and shrinkBudgetMs wall-clock time.
 * Returns undefined when no smaller value reproduces.
 */
export async function shrinkFuzzCase(
  params: ShrinkParams,
  replayFn: (value: unknown) => Promise<boolean>,
  options: { shrinkMaxSteps?: number; shrinkBudgetMs?: number } = {},
): Promise<unknown | undefined> {
  const { shrinkMaxSteps = 50, shrinkBudgetMs = 30_000 } = options;
  const deadline = Date.now() + shrinkBudgetMs;

  // Rebuild the same arbitrary to get the shrink tree
  const arb = buildArbitraryForStrategy(params.strategy, params.subSeed);
  if (arb === undefined) return undefined;

  // Sample to get the same value at drawIndex
  let samples: unknown[];
  try {
    samples = fc.sample(arb, { numRuns: params.drawIndex + 1, seed: params.subSeed });
  } catch {
    return undefined;
  }

  const drawn = samples[params.drawIndex];
  if (drawn === undefined) return undefined;

  // Manual shrink: generate candidates from the arbitrary and test smaller ones
  let best: unknown = drawn;
  let steps = 0;
  const shrinkCandidates = generateShrinkCandidates(drawn);

  for (const candidate of shrinkCandidates) {
    if (steps >= shrinkMaxSteps || Date.now() > deadline) break;
    steps++;
    try {
      const repros = await replayFn(candidate);
      if (repros) best = candidate;
    } catch {
      // Skip candidates that throw
    }
  }

  return best === drawn ? undefined : best;
}

function buildArbitraryForStrategy(strategy: FuzzStrategy, _seed: number): fc.Arbitrary<unknown> | undefined {
  switch (strategy) {
    case 'unicode':
      return unicodeArb(MAX_UNICODE_LEN) as fc.Arbitrary<unknown>;
    case 'shape':
    case 'boundary':
      return fc.string() as fc.Arbitrary<unknown>;
    default:
      return undefined;
  }
}

function* generateShrinkCandidates(value: unknown): Generator<unknown> {
  if (typeof value === 'string' && value.length > 0) {
    // Bisect the string length
    for (let len = Math.floor(value.length / 2); len >= 0; len = Math.floor(len / 2)) {
      yield value.slice(0, len);
      if (len === 0) break;
    }
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    // Try removing one key at a time
    for (const key of keys) {
      const copy = { ...obj };
      delete copy[key];
      yield copy;
    }
  }
}
