import * as path from 'node:path';
import * as fs from 'node:fs';
import { appendJsonl, writeJsonFile } from '../store/filesystem.js';
import { SuppressionsSchema } from './types.js';
import type { Suppressions, AuditEvent } from './types.js';
import { log } from '../log.js';

export type BugHunterPaths = {
  suppressionsFile: string;
  auditLogFile: string;
  triageFile: string;
  explanationsDir: string;
};

export function bugHunterPaths(projectDir: string): BugHunterPaths {
  const base = path.join(projectDir, '.bughunter');
  return {
    suppressionsFile: path.join(base, 'suppressions.json'),
    auditLogFile: path.join(base, 'suppressions-audit.log'),
    triageFile: path.join(base, 'triage.jsonl'),
    explanationsDir: path.join(base, 'explanations'),
  };
}

export function loadSuppressions(projectDir: string): Suppressions {
  const paths = bugHunterPaths(projectDir);
  if (!fs.existsSync(paths.suppressionsFile)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.suppressionsFile, 'utf-8'));
  } catch (err) {
    log.warn(`bughunter: suppressions.json failed to parse: ${String(err)}; treating as empty for this run`);
    return [];
  }

  const result = SuppressionsSchema.safeParse(raw);
  if (!result.success) {
    log.warn(`bughunter: suppressions.json failed to parse: ${result.error.message}; treating as empty for this run`);
    return [];
  }
  return result.data;
}

export function saveSuppressions(projectDir: string, suppressions: Suppressions): void {
  const paths = bugHunterPaths(projectDir);
  fs.mkdirSync(path.dirname(paths.suppressionsFile), { recursive: true });
  writeJsonFile(paths.suppressionsFile, suppressions);
}

export function appendAuditEvent(projectDir: string, event: AuditEvent): void {
  const paths = bugHunterPaths(projectDir);
  fs.mkdirSync(path.dirname(paths.auditLogFile), { recursive: true });
  appendJsonl(paths.auditLogFile, event);
}
