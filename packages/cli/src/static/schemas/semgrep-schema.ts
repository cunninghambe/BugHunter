// Zod schema for `semgrep --json` output.

import { z } from 'zod';

export const SemgrepResultSchema = z.object({
  check_id: z.string(),
  path: z.string(),
  start: z.object({ line: z.number(), col: z.number().optional() }),
  end: z.object({ line: z.number(), col: z.number().optional() }).optional(),
  extra: z.object({
    message: z.string().optional(),
    severity: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

export const SemgrepOutputSchema = z.object({
  results: z.array(SemgrepResultSchema),
  errors: z.array(z.unknown()).optional(),
});

export type SemgrepResult = z.infer<typeof SemgrepResultSchema>;
export type SemgrepOutput = z.infer<typeof SemgrepOutputSchema>;
