// JSON action log writer (§ 3.7).
// Each occurrence gets an action-logs/<occurrenceId>.json file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Action } from '../types.js';

export type ActionLogEntry = {
  step: number;
  kind: Action['kind'];
  selector?: string;
  url?: string;
  value?: unknown;
  role?: string;
  toolId?: string;
  palette?: string;
  input?: unknown;
  /** SHA-1 hash (first 12 hex chars) of the tool's inputSchema at the time this entry was written. */
  inputSchemaHash?: string;
  timestamp: string;
};

export type ActionLog = {
  occurrenceId: string;
  runId: string;
  role: string;
  page: string;
  baseUrl: string;
  actions: ActionLogEntry[];
  createdAt: string;
};

export function writeActionLog(actionLogsDir: string, log: ActionLog): string {
  const filePath = path.join(actionLogsDir, `${log.occurrenceId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2) + '\n');
  return filePath;
}

export function readActionLog(actionLogsDir: string, occurrenceId: string): ActionLog {
  const filePath = path.join(actionLogsDir, `${occurrenceId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Action log not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ActionLog;
}
