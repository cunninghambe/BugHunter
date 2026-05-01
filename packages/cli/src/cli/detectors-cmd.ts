// bughunter detectors — per-BugKind wiring report.

import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import type { DetectorStatus } from '../detectors/registry.js';
import type { BugKind } from '../types.js';

type DetectorsOptions = {
  kind?: BugKind;
  status?: DetectorStatus;
  format: 'table' | 'json';
};

const ALL_BUGKINDS = new Set<string>(DETECTOR_REGISTRY.map(e => e.kind));

export function detectorsCommand(projectDir: string, opts: DetectorsOptions): void {
  if (opts.kind !== undefined && !ALL_BUGKINDS.has(opts.kind)) {
    process.stdout.write(
      `Unknown BugKind: ${opts.kind}. Run 'bughunter detectors --format json' to list all kinds.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let entries = [...DETECTOR_REGISTRY];
  if (opts.kind !== undefined) entries = entries.filter(e => e.kind === opts.kind);
  if (opts.status !== undefined) entries = entries.filter(e => e.status === opts.status);

  // Sort: wired first, then deferred, then dead; alphabetic within group.
  const statusOrder: Record<DetectorStatus, number> = { wired: 0, deferred: 1, dead: 2 };
  entries.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status];
    return so !== 0 ? so : a.kind.localeCompare(b.kind);
  });

  if (opts.format === 'json') {
    printJson(entries);
    return;
  }

  printTable(entries);
}

function printJson(entries: typeof DETECTOR_REGISTRY[number][]): void {
  const total = DETECTOR_REGISTRY.length;
  const wired = DETECTOR_REGISTRY.filter(e => e.status === 'wired').length;
  const deferred = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').length;
  const dead = DETECTOR_REGISTRY.filter(e => e.status === 'dead').length;
  const output = {
    meta: { total, wired, deferred, dead },
    entries,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function printTable(entries: typeof DETECTOR_REGISTRY[number][]): void {
  const header = `${'BugKind'.padEnd(52)} | ${'Status'.padEnd(9)} | ${'Detector'.padEnd(43)} | Last fired`;
  const divider = '-'.repeat(header.length);
  process.stdout.write(`${header}\n${divider}\n`);

  for (const e of entries) {
    const kind = e.kind.padEnd(52);
    const status = e.status.padEnd(9);
    const site = (e.detectorSite ?? '-').padEnd(43);
    process.stdout.write(`${kind} | ${status} | ${site} | history-not-available\n`);
  }

  const wiredCount = DETECTOR_REGISTRY.filter(e => e.status === 'wired').length;
  const deferredCount = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').length;
  const deadCount = DETECTOR_REGISTRY.filter(e => e.status === 'dead').length;

  process.stdout.write(`\n${DETECTOR_REGISTRY.length} entries  (${wiredCount} wired, ${deferredCount} deferred, ${deadCount} dead)\n`);

  const specRefs = [...new Set(DETECTOR_REGISTRY.map(e => e.specReference))].sort().join(', ');
  process.stdout.write(`Spec promises: ${specRefs}\n`);
}
