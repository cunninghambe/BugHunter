// v0.42: `bughunter dataIntegrity check` sub-command.
// Parses config, validates invariants, warns on mismatches.

import { loadConfig } from '../config.js';
import { log } from '../log.js';
import type { DataIntegrityInvariant } from '../types.js';

export type DataIntegrityCheckOptions = {
  onlyInvariant?: string[];
  format?: 'table' | 'json';
};

export function dataIntegrityCheckCommand(projectDir: string, opts: DataIntegrityCheckOptions = {}): void {
  const config = loadConfig(projectDir);

  if (config.dataIntegrity === undefined || config.dataIntegrity.invariants.length === 0) {
    process.stdout.write('No data-integrity invariants configured (dataIntegrity.invariants is empty).\n');
    return;
  }

  const { invariants, enabled } = config.dataIntegrity;

  if (enabled === false) {
    process.stdout.write('WARN: dataIntegrity.enabled is false — invariants are disabled.\n');
  }

  const filtered = opts.onlyInvariant !== undefined && opts.onlyInvariant.length > 0
    ? invariants.filter(inv => opts.onlyInvariant!.includes(inv.name))
    : invariants;

  const rows = filtered.map(inv => validateInvariant(inv));

  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  printTable(rows);

  const hasWarnings = rows.some(r => r.status === 'WARN');
  if (hasWarnings) {
    log.warn('data-integrity check: some invariants have warnings');
    process.exitCode = 1;
  }
}

type CheckRow = {
  name: string;
  bugKind: string;
  status: 'ok' | 'WARN';
  message: string;
};

function validateInvariant(inv: DataIntegrityInvariant): CheckRow {
  const warnings: string[] = [];

  if (inv.after === undefined && inv.bugKind !== 'idempotency_key_violation') {
    warnings.push('missing after clause');
  }

  if (inv.bugKind === 'idempotency_key_violation' && inv.replay === undefined) {
    warnings.push('idempotency_key_violation requires replay clause');
  }

  if (inv.bugKind === 'money_math_precision' && inv.injectInputs === undefined) {
    warnings.push('money_math_precision should have injectInputs');
  }

  if (inv.appliesTo.method === undefined && inv.appliesTo.urlPattern === undefined && inv.appliesTo.actionIds === undefined) {
    warnings.push('appliesTo has no filters — invariant matches ALL mutating actions');
  }

  const status = warnings.length > 0 ? 'WARN' : 'ok';
  return { name: inv.name, bugKind: inv.bugKind, status, message: warnings.join('; ') || 'ok' };
}

function printTable(rows: CheckRow[]): void {
  const header = 'INVARIANT                                   BUGKIND                            STATUS  MESSAGE';
  process.stdout.write(`${header}\n${'─'.repeat(header.length)}\n`);
  for (const row of rows) {
    const name = row.name.padEnd(43).slice(0, 43);
    const kind = row.bugKind.padEnd(34).slice(0, 34);
    const status = row.status.padEnd(7);
    process.stdout.write(`${name} ${kind} ${status} ${row.message}\n`);
  }
  process.stdout.write(`\n${rows.length} invariant(s) checked.\n`);
}
