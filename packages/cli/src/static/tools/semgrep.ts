// Semgrep static-analysis adapter (v0.5 T09).

import type { BugDetection } from '../../types.js';
import { SemgrepOutputSchema } from '../schemas/semgrep-schema.js';
import type { StaticTool } from '../runner.js';

// Semgrep rule-id prefixes that map to hardcoded_credentials_in_source.
const SECRETS_PREFIXES = ['secrets.', 'generic.secrets.', 'javascript.secrets.', 'typescript.secrets.'];

function isSecretsRule(checkId: string): boolean {
  const lower = checkId.toLowerCase();
  return SECRETS_PREFIXES.some(p => lower.startsWith(p));
}

export const semgrepTool: StaticTool = {
  id: 'semgrep',
  binary: 'semgrep',
  args: (_projectDir) => [
    '--config=p/owasp-top-ten',
    '--config=p/secrets',
    '--config=p/javascript',
    '--config=p/typescript',
    '--json',
    '--quiet',
    '--error',
    '--severity=ERROR',
    '--severity=WARNING',
  ],
  timeoutMs: 120_000,
  optional: true,
  parseStdout,
};

function parseStdout(raw: string): { detections: BugDetection[]; warnings: string[] } {
  const parsed = SemgrepOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { detections: [], warnings: [`semgrep schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = [];

  for (const result of parsed.data.results) {
    if (!isSecretsRule(result.check_id)) continue;

    detections.push({
      kind: 'hardcoded_credentials_in_source',
      rootCause: `Possible secret (${result.check_id}) in ${result.path}:${result.start.line}`,
      staticContext: {
        tool: 'semgrep',
        ruleId: result.check_id,
        sourceFile: result.path,
        sourceLine: result.start.line,
      },
    });
  }

  return { detections, warnings: [] };
}
