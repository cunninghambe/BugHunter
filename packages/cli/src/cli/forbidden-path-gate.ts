// bughunter forbidden-path-gate — JSON-output CLI op (§ 3.9.1).

import { forbiddenPathGate } from '../ops/forbidden-paths.js';

export function forbiddenPathGateCommand(
  projectDir: string,
  branch: string,
  baseBranch: string,
  reset: boolean,
): void {
  const result = forbiddenPathGate(projectDir, branch, baseBranch, reset);
  process.stdout.write(`${JSON.stringify(result)  }\n`);
}
