// Gitleaks static-analysis adapter (v0.5 T07).

import type { BugDetection } from '../../types.js';
import { GitleaksOutputSchema } from '../schemas/gitleaks-schema.js';
import type { StaticTool } from '../runner.js';

export const gitleaksTool: StaticTool = {
  id: 'gitleaks',
  binary: 'gitleaks',
  args: (projectDir) => [
    'detect',
    '--source', projectDir,
    '--report-format', 'json',
    '--report-path', '-',
    '--no-git',
    '--exit-code', '0',
  ],
  timeoutMs: 120_000,
  optional: true,
  parseStdout,
};

function parseStdout(raw: string): { detections: BugDetection[]; warnings: string[] } {
  const parsed = GitleaksOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { detections: [], warnings: [`gitleaks schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = parsed.data.map(finding => ({
    kind: 'hardcoded_credentials_in_source' as const,
    rootCause: `Possible secret (${finding.RuleID}) in ${finding.File}:${finding.StartLine ?? '?'}`,
    staticContext: {
      tool: 'gitleaks',
      ruleId: finding.RuleID,
      sourceFile: finding.File,
      sourceLine: finding.StartLine,
    },
  }));

  return { detections, warnings: [] };
}
