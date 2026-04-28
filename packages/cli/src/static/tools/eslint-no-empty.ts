// ESLint no-empty static-analysis adapter (v0.5 T10).

import type { BugDetection } from '../../types.js';
import { EslintOutputSchema } from '../schemas/eslint-schema.js';
import type { StaticTool } from '../runner.js';

const GLOB_PATTERN = 'src/**/*.{ts,tsx,js,jsx}';

export const eslintNoEmptyTool: StaticTool = {
  id: 'eslint-no-empty',
  binary: 'npx',
  args: (_projectDir) => [
    'eslint',
    '--no-eslintrc',
    '--rule', '{"no-empty":"error"}',
    '--format', 'json',
    GLOB_PATTERN,
  ],
  timeoutMs: 60_000,
  optional: true,
  parseStdout,
};

function parseStdout(raw: string): { detections: BugDetection[]; warnings: string[] } {
  const parsed = EslintOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { detections: [], warnings: [`eslint-no-empty schema parse error: ${parsed.error.message}`] };
  }

  const detections: BugDetection[] = [];

  for (const fileResult of parsed.data) {
    for (const msg of fileResult.messages) {
      if (msg.ruleId !== 'no-empty') continue;
      detections.push({
        kind: 'swallowed_error_empty_catch',
        rootCause: `Empty catch block in ${fileResult.filePath}:${msg.line ?? '?'}`,
        staticContext: {
          tool: 'eslint-no-empty',
          ruleId: 'no-empty',
          sourceFile: fileResult.filePath,
          sourceLine: msg.line,
        },
      });
    }
  }

  return { detections, warnings: [] };
}
