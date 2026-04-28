// Vision auth detection helper (v0.5 T03) — pure function, no IO at module load.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type VisionAuthDetectResult =
  | { kind: 'claudeCli'; binaryPath: string }
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'unavailable'; reason: string };

/** Merge provided PATH with system PATH so that shebang interpreters (node, sh) remain resolvable. */
function mergedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = process.env['PATH'] ?? '/usr/bin:/bin';
  const extra = env['PATH'] ?? '';
  const merged = extra !== '' ? `${extra}:${base}` : base;
  return { ...process.env, ...env, PATH: merged };
}

function execFileAsync(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    });
  });
}

/** Search each directory in PATH for an executable named `name`. */
function findInPath(name: string, pathEnv: string | undefined): string | null {
  const dirs = (pathEnv ?? '').split(':').filter(d => d !== '');
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable in this dir
    }
  }
  return null;
}

/**
 * Detect which vision auth method is available:
 * 1. If `claude` is on PATH and responds to `--version`, use Claude CLI subprocess.
 * 2. Else if ANTHROPIC_API_KEY is set, use API key.
 * 3. Else unavailable.
 */
export async function detectVisionAuth(env: NodeJS.ProcessEnv): Promise<VisionAuthDetectResult> {
  const binaryPath = findInPath('claude', env['PATH']);
  if (binaryPath !== null) {
    const versionOk = await verifyClaudeVersion(binaryPath, mergedEnv(env));
    if (versionOk) {
      return { kind: 'claudeCli', binaryPath };
    }
  }

  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey !== undefined && apiKey !== '') {
    return { kind: 'apiKey', apiKey };
  }

  return { kind: 'unavailable', reason: 'no Claude CLI on PATH and no ANTHROPIC_API_KEY' };
}

async function verifyClaudeVersion(binaryPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['--version'], 1000, env);
    return true;
  } catch {
    return false;
  }
}
