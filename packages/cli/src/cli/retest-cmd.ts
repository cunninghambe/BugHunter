// bughunter retest — JSON-output CLI op (§ 3.9.1).

import { retestOp } from '../ops/retest.js';

export async function retestCommand(
  projectDir: string,
  runId: string,
  clusterId: string,
  baseBranch: string | undefined,
  fixBranch: string | undefined,
): Promise<void> {
  const result = await retestOp(projectDir, runId, clusterId, baseBranch, fixBranch);
  process.stdout.write(`${JSON.stringify(result)  }\n`);
}
