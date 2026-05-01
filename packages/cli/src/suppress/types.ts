import { z } from 'zod';

export const SuppressionPatternSchema = z.string().regex(
  /^(bugIdentity|kind|endpoint|suspectedFile|severity):[^\s]+$/,
  'pattern must be one of bugIdentity:<value>, kind:<BugKind>, endpoint:<glob>, suspectedFile:<glob>, severity:<critical|major|minor|info>',
);

export const SuppressionEntrySchema = z.object({
  /** Stable cuid for the suppression itself; never reused. */
  id: z.string().min(1),
  pattern: SuppressionPatternSchema,
  /** Free-text reason; required at suppress-time. No newlines. Max 1000 chars. */
  reason: z.string().min(1).max(1000).regex(/^[^\n\r]+$/, 'reason cannot contain newlines'),
  /** git config user.email at suppress-time; 'unknown' when git is missing/unconfigured. */
  addedBy: z.string().min(1),
  addedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  lastMatchedAt: z.string().datetime().optional(),
  matchCount: z.number().int().nonnegative().optional(),
  sourceClusterId: z.string().optional(),
});

export const SuppressionsSchema = z.array(SuppressionEntrySchema);

export const AuditEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('suppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    pattern: SuppressionPatternSchema,
    reason: z.string().min(1).max(1000),
    expiresAt: z.string().datetime().optional(),
    sourceClusterId: z.string().optional(),
    suppressionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unsuppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    pattern: SuppressionPatternSchema,
    removedSuppressionIds: z.array(z.string()).min(1),
    removedCount: z.number().int().positive(),
  }),
]);

export type SuppressionEntry = z.infer<typeof SuppressionEntrySchema>;
export type Suppressions = z.infer<typeof SuppressionsSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export type SuppressedSample = {
  clusterId: string;
  kind: string;
  bugIdentity?: string;
  matchedPattern: string;
  suppressionId: string;
};
