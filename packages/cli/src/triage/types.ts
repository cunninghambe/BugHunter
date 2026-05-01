import { z } from 'zod';

export const ClusterVerdictSchema = z.enum([
  'bug',
  'fix-priority',
  'false-positive',
  'known',
]);
export type ClusterVerdictMark = z.infer<typeof ClusterVerdictSchema>;

export const TriageEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('verdict'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    bugIdentity: z.string().optional(),
    mark: ClusterVerdictSchema,
    note: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('suppress'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    pattern: z.string().min(1),
    reason: z.string().min(1).max(1000),
    suppressionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('explain-requested'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
    cacheHit: z.boolean(),
    cost: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('fix-dispatched'),
    timestamp: z.string().datetime(),
    actor: z.string().min(1),
    runId: z.string().min(1),
    clusterId: z.string().min(1),
  }),
]);

export type TriageEvent = z.infer<typeof TriageEventSchema>;
