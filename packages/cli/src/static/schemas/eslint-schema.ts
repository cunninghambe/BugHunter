// Zod schema for `eslint --format json` output.

import { z } from 'zod';

const EslintMessageSchema = z.object({
  ruleId: z.string().nullable().optional(),
  severity: z.number(),
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  nodeType: z.string().nullable().optional(),
});

export const EslintFileResultSchema = z.object({
  filePath: z.string(),
  messages: z.array(EslintMessageSchema),
  errorCount: z.number().optional(),
  warningCount: z.number().optional(),
});

export const EslintOutputSchema = z.array(EslintFileResultSchema);

export type EslintMessage = z.infer<typeof EslintMessageSchema>;
export type EslintFileResult = z.infer<typeof EslintFileResultSchema>;
