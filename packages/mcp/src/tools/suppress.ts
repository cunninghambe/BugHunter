// bughunt_suppress / bughunt_unsuppress — manage suppression rules.
// CLI parity: bughunter suppress / bughunter unsuppress (V28).

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createId } from '@paralleldrive/cuid2';
import { toolOk, toolErr } from '../envelope.js';
import { withLock, atomicWriteJson } from './locks.js';
import { resolveProjectDir } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';

type SuppressionEntry = {
  entryId: string;
  pattern: string;
  reason: string;
  expiresAt?: string;
  clusterId?: string;
  bugIdentity?: string;
  addedBy: string;
  addedAt: string;
};

type AuditRecord = {
  action: 'add' | 'remove';
  entryId?: string;
  pattern?: string;
  reason?: string;
  addedBy?: string;
  removedBy?: string;
  ts: string;
};

function suppressionsPath(projectDir: string): string {
  return path.join(projectDir, '.bughunter', 'suppressions.json');
}

function auditLogPath(projectDir: string): string {
  return path.join(projectDir, '.bughunter', 'suppressions-audit.log');
}

function lockPath(projectDir: string): string {
  return path.join(projectDir, '.bughunter', '.suppressions.lock');
}

function readSuppressions(projectDir: string): SuppressionEntry[] {
  const p = suppressionsPath(projectDir);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as SuppressionEntry[];
}

function resolveAuthor(projectDir: string, override?: string): string {
  if (override !== undefined && override !== '') return override;
  try {
    return execSync('git config user.email', { cwd: projectDir, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown@mcp';
  }
}

function appendAudit(projectDir: string, record: AuditRecord): void {
  fs.appendFileSync(auditLogPath(projectDir), `${JSON.stringify(record)}\n`);
}

function countMatchingClusters(projectDir: string, pattern: string): number {
  const runsDir = path.join(projectDir, '.bughunter', 'runs');
  if (!fs.existsSync(runsDir)) return 0;
  let count = 0;
  for (const runId of fs.readdirSync(runsDir)) {
    const bugsFile = path.join(runsDir, runId, 'bugs.jsonl');
    if (!fs.existsSync(bugsFile)) continue;
    const lines = fs.readFileSync(bugsFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const cluster = JSON.parse(line) as { id?: string; kind?: string };
        const colonIdx = pattern.indexOf(':');
        const pfx = colonIdx >= 0 ? pattern.slice(0, colonIdx) : pattern;
        const val = colonIdx >= 0 ? pattern.slice(colonIdx + 1) : '';
        if (pfx === 'cluster' && cluster.id === val) count++;
        else if (pfx === 'kind' && cluster.kind === val) count++;
        // endpoint / file glob matching deferred — return 0 for those
      } catch { /* skip malformed */ }
    }
  }
  return count;
}

const SuppressInput = z.object({
  project: z.string().min(1),
  pattern: z.string().min(1),
  reason: z.string().min(8),
  expiresAt: z.string().datetime().optional(),
  clusterId: z.string().optional(),
  bugIdentity: z.string().optional(),
  addedBy: z.string().min(1).optional(),
});

// Note: cannot use .refine() on server.tool() shape arg because ZodEffects lacks .shape.
// The at-least-one-of constraint is validated inside the handler instead.
const UnsuppressInput = z.object({
  project: z.string().min(1),
  entryId: z.string().optional(),
  pattern: z.string().optional(),
});

export function registerSuppressTools(server: McpServer): void {
  server.tool(
    'bughunt_suppress',
    'Add a suppression rule. Subsequent runs skip clusters matching the pattern.',
    SuppressInput.shape,
    async (args) => {
      const parsed = SuppressInput.safeParse(args);
      if (!parsed.success) return toolErr('invalid_input', parsed.error.issues.map(i => i.message).join('; '));
      try {
        const projectDir = resolveProjectDir(parsed.data.project);
        fs.mkdirSync(path.join(projectDir, '.bughunter'), { recursive: true });
        const addedBy = resolveAuthor(projectDir, parsed.data.addedBy);
        const entryId = createId();
        const addedAt = new Date().toISOString();

        await withLock(lockPath(projectDir), 5000, () => {
          const entries = readSuppressions(projectDir);
          const entry: SuppressionEntry = {
            entryId,
            pattern: parsed.data.pattern,
            reason: parsed.data.reason,
            addedBy,
            addedAt,
          };
          if (parsed.data.expiresAt !== undefined) entry.expiresAt = parsed.data.expiresAt;
          if (parsed.data.clusterId !== undefined) entry.clusterId = parsed.data.clusterId;
          if (parsed.data.bugIdentity !== undefined) entry.bugIdentity = parsed.data.bugIdentity;
          entries.push(entry);
          atomicWriteJson(suppressionsPath(projectDir), entries);
          appendAudit(projectDir, { action: 'add', entryId, pattern: parsed.data.pattern, reason: parsed.data.reason, addedBy, ts: addedAt });
        });

        const suppressed = countMatchingClusters(projectDir, parsed.data.pattern);
        return toolOk({ ok: true, entryId, suppressed });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        if (e instanceof Error && e.message === 'lock_timeout') return toolErr('concurrent_write', 'Lock acquisition timed out; retry in a moment');
        return toolErr('error', String(e));
      }
    },
  );

  server.tool(
    'bughunt_unsuppress',
    'Remove a suppression rule by entryId or by exact pattern match.',
    UnsuppressInput.shape,
    async (args) => {
      try {
        if (args.entryId === undefined && args.pattern === undefined) {
          return toolErr('invalid_input', 'entryId or pattern required');
        }
        const projectDir = resolveProjectDir(args.project);
        fs.mkdirSync(path.join(projectDir, '.bughunter'), { recursive: true });
        const removedBy = resolveAuthor(projectDir, undefined);
        const ts = new Date().toISOString();
        let removed = 0;

        await withLock(lockPath(projectDir), 5000, () => {
          const entries = readSuppressions(projectDir);
          const kept: SuppressionEntry[] = [];
          for (const e of entries) {
            const matches =
              (args.entryId !== undefined && e.entryId === args.entryId) ||
              (args.pattern !== undefined && e.pattern === args.pattern);
            if (matches) {
              removed++;
              appendAudit(projectDir, { action: 'remove', entryId: e.entryId, pattern: e.pattern, removedBy, ts });
            } else {
              kept.push(e);
            }
          }
          if (removed > 0) atomicWriteJson(suppressionsPath(projectDir), kept);
        });

        return toolOk({ ok: true, removed });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        if (e instanceof Error && e.message === 'lock_timeout') return toolErr('concurrent_write', 'Lock acquisition timed out; retry in a moment');
        return toolErr('error', String(e));
      }
    },
  );
}
