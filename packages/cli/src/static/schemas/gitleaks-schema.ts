// Zod schema for gitleaks --report-format json output.

import { z } from 'zod';

export const GitleaksFindingSchema = z.object({
  RuleID: z.string(),
  File: z.string(),
  StartLine: z.number().optional(),
  Secret: z.string().optional(),
  Match: z.string().optional(),
  Description: z.string().optional(),
});

export const GitleaksOutputSchema = z.array(GitleaksFindingSchema);

export type GitleaksFinding = z.infer<typeof GitleaksFindingSchema>;
