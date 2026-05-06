// Semgrep static-analysis adapter (v0.5 T09).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugDetection } from '../../types.js';
import { SemgrepOutputSchema } from '../schemas/semgrep-schema.js';
import type { StaticTool } from '../runner.js';

// Semgrep rule-id prefixes that map to hardcoded_credentials_in_source.
const SECRETS_PREFIXES = ['secrets.', 'generic.secrets.', 'javascript.secrets.', 'typescript.secrets.'];

function isSecretsRule(checkId: string): boolean {
  const lower = checkId.toLowerCase();
  return SECRETS_PREFIXES.some(p => lower.startsWith(p));
}

/**
 * Inspect the source line + 2 surrounding lines for context that signals this is
 * a deliberately-public constant (timing-mitigation, test fixture, documented
 * placeholder), not a leaked credential. Spoonworks calibration (May 2026):
 * `lib/auth.ts:33` defines a dummy bcrypt hash with a comment explaining
 * "valid bcrypt hash of a random string" — gitleaks pattern-matched, not a leak.
 */
const FP_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdummy\b/i,
  /\bplaceholder\b/i,
  /\bfixture\b/i,
  /\btest[-_]?(value|user|secret|password|hash)\b/i,
  /\bexample\b/i,
  /\bsample\b/i,
  /timing[-_]?(attack|side|safe)/i,
  /constant[-_]?time/i,
  /enumeration/i,
  /\bnot[-_]?a[-_]?(real|secret)/i,
  /\bRANDOM[-_]?STRING\b/i,
];

function looksLikeFalsePositive(projectDir: string, sourceFile: string, sourceLine: number): boolean {
  try {
    const fullPath = path.isAbsolute(sourceFile) ? sourceFile : path.join(projectDir, sourceFile);
    if (!fs.existsSync(fullPath)) return false;
    const content = fs.readFileSync(fullPath, 'utf8').split('\n');
    const start = Math.max(0, sourceLine - 4);
    const end = Math.min(content.length, sourceLine + 1);
    const window = content.slice(start, end).join('\n');
    return FP_CONTEXT_PATTERNS.some(re => re.test(window));
  } catch {
    return false;
  }
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

function parseStdout(raw: string, projectDir: string): { detections: BugDetection[]; warnings: string[] } {
  const parsed = SemgrepOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { detections: [], warnings: [`semgrep schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = [];

  for (const result of parsed.data.results) {
    if (!isSecretsRule(result.check_id)) continue;

    // Drop matches whose surrounding context signals deliberate-public usage
    // (timing-mitigation dummy hashes, test fixtures, documented placeholders).
    const isFalsePositive = looksLikeFalsePositive(projectDir, result.path, result.start.line);
    if (isFalsePositive) continue;

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
