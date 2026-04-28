// bughunter status <runId> — detailed status of a run.

import { runPaths, readJsonFile, fileExists } from '../store/filesystem.js';
import type { RunState, RunSummary } from '../types.js';

export function statusCommand(projectDir: string, runId: string): void {
  const paths = runPaths(projectDir, runId);
  if (!fileExists(paths.stateFile)) {
    process.stdout.write(`Run ${runId} not found.\n`);
    process.exitCode = 1;
    return;
  }

  const state = readJsonFile<RunState>(paths.stateFile);
  process.stdout.write(`${JSON.stringify(state, null, 2)  }\n`);

  if (fileExists(paths.summaryFile)) {
    const summary = readJsonFile<RunSummary>(paths.summaryFile);
    printV06Summaries(summary);
  }
}

function printV06Summaries(summary: RunSummary): void {
  if (summary.perfSummary !== undefined) {
    const p = summary.perfSummary;
    process.stdout.write('\n--- Performance Summary ---\n');
    process.stdout.write(`  Web vitals measured on ${Object.keys(p.vitalsByPage).length} occurrence(s)\n`);
    if (p.longestTaskMs > 0) process.stdout.write(`  Longest main-thread task: ${p.longestTaskMs}ms\n`);
    if (p.totalNetworkRequests > 0) process.stdout.write(`  Total network requests: ${p.totalNetworkRequests}\n`);
    if (p.heapGrowthBytesPerSec !== undefined) {
      process.stdout.write(`  Heap growth rate: ${Math.round(p.heapGrowthBytesPerSec / 1024)}KB/s\n`);
    }
    if (p.worstNPlusOne !== undefined) {
      process.stdout.write(`  Worst N+1: ${p.worstNPlusOne.endpoint} (${p.worstNPlusOne.count} requests)\n`);
    }
  }

  if (summary.bundleSummary !== undefined) {
    const b = summary.bundleSummary;
    const jskb = Math.round(b.initialJsBytesGzipped / 1024);
    const csskb = Math.round(b.initialCssBytesGzipped / 1024);
    process.stdout.write('\n--- Bundle Summary ---\n');
    process.stdout.write(`  Initial JS: ${jskb}KB gzipped\n`);
    process.stdout.write(`  Initial CSS: ${csskb}KB gzipped\n`);
    process.stdout.write(`  Budget exceeded: ${b.budgetExceeded ? 'YES' : 'no'}\n`);
  }
}
