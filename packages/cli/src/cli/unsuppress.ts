import { SuppressionPatternSchema } from '../suppress/types.js';
import { loadSuppressions, saveSuppressions, appendAuditEvent } from '../suppress/io.js';
import { getGitUserEmail } from '../suppress/git.js';

export type UnsuppressOpts = {
  projectDir: string;
  pattern: string;
};

export function unsuppressCommand(opts: UnsuppressOpts): void {
  const patternResult = SuppressionPatternSchema.safeParse(opts.pattern);
  if (!patternResult.success) {
    process.stderr.write(`Error: ${patternResult.error.errors[0]?.message ?? 'invalid pattern'}\n`);
    process.exitCode = 2;
    return;
  }

  const suppressions = loadSuppressions(opts.projectDir);
  const kept = suppressions.filter(e => e.pattern !== opts.pattern);
  const removed = suppressions.filter(e => e.pattern === opts.pattern);

  if (removed.length === 0) {
    process.stdout.write('No matching suppressions to remove\n');
    return;
  }

  const actor = getGitUserEmail(opts.projectDir);
  // Write audit BEFORE deleting (write-then-delete for crash safety)
  appendAuditEvent(opts.projectDir, {
    kind: 'unsuppress',
    timestamp: new Date().toISOString(),
    actor,
    pattern: patternResult.data,
    removedSuppressionIds: removed.map(r => r.id),
    removedCount: removed.length,
  });

  saveSuppressions(opts.projectDir, kept);

  process.stdout.write(`Removed ${removed.length} suppression(s) for ${opts.pattern}\n`);
}
