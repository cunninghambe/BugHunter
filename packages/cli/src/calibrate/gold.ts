// v0.44: Gold-standard JSONL schema, loader, and --record-identities rewriter.

import * as fs from 'node:fs';
import { z } from 'zod';
import type { BugKind } from '../types.js';

// ---------------------------------------------------------------------------
// Zod schema for a single gold entry
// ---------------------------------------------------------------------------

const StructuralMatchSchema = z.object({
  kind: z.string(),
  normalizedLocation: z.string(),
  normalizedMessage: z.string(),
  suspectedFile: z.string().optional(),
});

export const GoldEntrySchema = z.object({
  goldId: z.string().regex(/^[a-z][a-z0-9-]+-\d{3}$/, 'goldId must be <app-id>-<3-digit-counter>'),
  kind: z.string(),
  expected: z.union([z.literal('detector_fires'), z.literal('detector_silent')]),
  bugIdentity: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  structuralMatch: StructuralMatchSchema.optional(),
  rationale: z.string().min(1),
  humanRepro: z.array(z.string()).min(1),
  minClusterSize: z.number().int().positive().optional(),
  addedInBenchVersion: z.string().min(1),
}).refine(
  d => d.bugIdentity !== undefined || d.structuralMatch !== undefined,
  { message: 'Either bugIdentity or structuralMatch must be present' },
);

export type GoldEntry = {
  goldId: string;
  kind: BugKind;
  expected: 'detector_fires' | 'detector_silent';
  bugIdentity?: string;
  structuralMatch?: {
    kind: string;
    normalizedLocation: string;
    normalizedMessage: string;
    suspectedFile?: string;
  };
  rationale: string;
  humanRepro: string[];
  minClusterSize?: number;
  addedInBenchVersion: string;
};

// ---------------------------------------------------------------------------
// Loader: parse and validate a gold-standard.jsonl file
// ---------------------------------------------------------------------------

export type GoldLoadError = {
  lineNumber: number;
  goldId?: string;
  message: string;
};

export type GoldLoadResult =
  | { ok: true; entries: GoldEntry[] }
  | { ok: false; errors: GoldLoadError[] };

export function loadGoldStandard(filePath: string): GoldLoadResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, errors: [{ lineNumber: 0, message: `File not found: ${filePath}` }] };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const errors: GoldLoadError[] = [];
  const entries: GoldEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (e) {
      errors.push({ lineNumber, message: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const result = GoldEntrySchema.safeParse(parsed);
    if (!result.success) {
      const goldId = typeof (parsed as Record<string, unknown>)['goldId'] === 'string'
        ? (parsed as Record<string, unknown>)['goldId'] as string
        : undefined;
      errors.push({
        lineNumber,
        goldId,
        message: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }

    entries.push(result.data as GoldEntry);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// --record-identities: rewrite gold file with bugIdentity filled in
// ---------------------------------------------------------------------------

export type IdentityUpdateSpec = {
  goldId: string;
  newIdentity: string;
  oldIdentity?: string;
};

export type RecordIdentitiesResult =
  | { changed: true; updatedLines: number; diff: string }
  | { changed: false };

export function recordIdentitiesInGold(
  filePath: string,
  updates: IdentityUpdateSpec[],
): RecordIdentitiesResult {
  if (updates.length === 0) return { changed: false };

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const updateMap = new Map(updates.map(u => [u.goldId, u]));

  let changed = 0;
  const diffLines: string[] = [];
  const newLines = lines.map(line => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }

    const goldId = parsed['goldId'] as string | undefined;
    if (goldId === undefined) return line;

    const upd = updateMap.get(goldId);
    if (upd === undefined) return line;

    const before = JSON.stringify(parsed);
    parsed['bugIdentity'] = upd.newIdentity;
    const after = JSON.stringify(parsed);

    if (before !== after) {
      changed++;
      diffLines.push(`- ${before}`);
      diffLines.push(`+ ${after}`);
    }

    return after;
  });

  if (changed === 0) return { changed: false };

  fs.writeFileSync(filePath, `${newLines.join('\n')  }\n`);
  return { changed: true, updatedLines: changed, diff: diffLines.join('\n') };
}
