import { createId } from '@paralleldrive/cuid2';
import { SuppressionPatternSchema } from '../suppress/types.js';
import { loadSuppressions, saveSuppressions, appendAuditEvent } from '../suppress/io.js';
import { getGitUserEmail } from '../suppress/git.js';
import { parseExpires } from '../suppress/expires.js';

export type SuppressOpts = {
  projectDir: string;
  pattern: string;
  reason: string;
  expires?: string;
  clusterId?: string;
};

export function suppressCommand(opts: SuppressOpts): void {
  const patternResult = SuppressionPatternSchema.safeParse(opts.pattern);
  if (!patternResult.success) {
    process.stderr.write(`Error: ${patternResult.error.errors[0]?.message ?? 'invalid pattern'}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.reason === '') {
    process.stderr.write('Error: --reason is required\n');
    process.exitCode = 2;
    return;
  }
  if (/[\n\r]/.test(opts.reason)) {
    process.stderr.write('Error: --reason cannot contain newlines (use ; or // for separators)\n');
    process.exitCode = 2;
    return;
  }
  if (opts.reason.length > 1000) {
    process.stderr.write('Error: --reason must be 1000 characters or fewer\n');
    process.exitCode = 2;
    return;
  }

  let expiresAt: string | undefined;
  if (opts.expires !== undefined) {
    try {
      expiresAt = parseExpires(opts.expires);
    } catch (err) {
      process.stderr.write(`Error: ${String(err)}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const suppressions = loadSuppressions(opts.projectDir);
  const addedBy = getGitUserEmail(opts.projectDir);
  const nowMs = Date.now();

  const duplicate = suppressions.find(e =>
    e.pattern === opts.pattern &&
    e.addedBy === addedBy &&
    nowMs - new Date(e.addedAt).getTime() < 60_000
  );
  if (duplicate !== undefined) {
    process.stdout.write(`Already suppressed by ${addedBy} at ${duplicate.addedAt}\n`);
    return;
  }

  const entry = {
    id: createId(),
    pattern: patternResult.data,
    reason: opts.reason,
    addedBy,
    addedAt: new Date().toISOString(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(opts.clusterId !== undefined ? { sourceClusterId: opts.clusterId } : {}),
    matchCount: 0,
  };

  const updated = [...suppressions, entry];
  saveSuppressions(opts.projectDir, updated);

  appendAuditEvent(opts.projectDir, {
    kind: 'suppress',
    timestamp: entry.addedAt,
    actor: addedBy,
    pattern: entry.pattern,
    reason: entry.reason,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(opts.clusterId !== undefined ? { sourceClusterId: opts.clusterId } : {}),
    suppressionId: entry.id,
  });

  process.stdout.write(`Suppressed ${opts.pattern} (${entry.id}); added to .bughunter/suppressions.json\n`);
}
