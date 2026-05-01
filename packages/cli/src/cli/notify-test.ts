// bughunter notify-test — dry-run all configured notification channels.

import { loadConfig } from '../config.js';
import { fireNotifications } from '../notify/send.js';

export async function notifyTestCommand(projectDir: string, opts: { json?: boolean }): Promise<void> {
  const config = loadConfig(projectDir);

  if (config.notifications === undefined) {
    process.stdout.write('No notifications config found in .bughunter/config.json\n');
    process.stdout.write('Add a "notifications" block to configure channels.\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Dry-running notification channels...\n');

  const results = await fireNotifications({
    config: config.notifications,
    projectDir,
    runId: 'notify-test-run',
    projectName: config.projectName,
    clusters: [],
    bySeverity: {},
    byKind: {},
    crossRun: undefined,
    actualRuntimeMs: 0,
    dryRun: true,
  });

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  if (results.length === 0) {
    process.stdout.write('No channels would fire for the current trigger state (empty run).\n');
    process.stdout.write('Tip: use defaultTriggers: ["summary"] to always fire at least one.\n');
    return;
  }

  for (const r of results) {
    const status = r.ok ? 'OK' : 'FAIL';
    process.stdout.write(`  [${status}] ${r.channelKind} (trigger: ${r.trigger})\n`);
  }
  process.stdout.write(`\nDone. ${results.length} channel(s) evaluated.\n`);
}
