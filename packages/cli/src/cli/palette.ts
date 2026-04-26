// bughunter palette — print active mutation palette.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.js';
import type { InputType } from '../types.js';

const ALL_INPUT_TYPES: InputType[] = [
  'text', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'boolean',
  'array', 'tel', 'url', 'password', 'color', 'range', 'slug', 'foreign_id',
];

export function paletteCommand(projectDir: string): void {
  const config = loadConfig(projectDir);

  // Check for user overrides
  const overridePath = config.paletteOverridePath
    ?? path.join(projectDir, '.bughunter', 'palette.json');

  let overrides: Record<string, unknown> = {};
  if (fs.existsSync(overridePath)) {
    overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as Record<string, unknown>;
  }

  process.stdout.write('\nActive mutation palette:\n\n');
  process.stdout.write('Input Type       | null        | happy       | edge        | out_of_bounds\n');
  process.stdout.write('-----------------|-------------|-------------|-------------|---------------\n');

  for (const type of ALL_INPUT_TYPES) {
    process.stdout.write(`${type.padEnd(16)} | (see src)   | (see src)   | (see src)   | (see src)\n`);
  }

  if (Object.keys(overrides).length > 0) {
    process.stdout.write('\nUser overrides from palette.json:\n');
    process.stdout.write(JSON.stringify(overrides, null, 2) + '\n');
  } else {
    process.stdout.write('\nNo overrides. Edit .bughunter/palette.json to customize.\n');
  }
}
