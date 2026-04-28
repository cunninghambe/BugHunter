// v0.14 seed-data hook runner.
// Shell executor mirrors static/runner.ts pattern.
// HTTP executor mirrors security/header-probe.ts pattern.

import { spawn } from 'node:child_process';
import type { SeedHook, SeedHookExecution } from '../types.js';
import { log } from '../log.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STREAM_BYTES = 64 * 1024;
const OUTPUT_TRUNCATE_CHARS = 500;
// Grace period between SIGTERM and SIGKILL when a hook times out.
const SIGKILL_GRACE_MS = 5_000;

export type SeedHookContext = {
  projectDir: string;
  appBaseUrl?: string;
  role?: string;
  lifecyclePoint: SeedHookExecution['lifecyclePoint'];
};

/**
 * Run a single seed hook and return its execution record.
 * Never throws — all errors are captured in the returned record.
 */
export async function runSeedHook(hook: SeedHook, ctx: SeedHookContext): Promise<SeedHookExecution> {
  const description = hook.description ?? (hook.kind === 'shell' ? hook.command : `${hook.method} ${hook.url}`);
  log.info('seed: hook starting', { lifecyclePoint: ctx.lifecyclePoint, kind: hook.kind, description });

  const invokeStart = Date.now();
  type OutcomeFields = Pick<SeedHookExecution, 'ok' | 'durationMs' | 'exitCode' | 'output' | 'reason' | 'status'>;
  let result: OutcomeFields;
  try {
    result = hook.kind === 'shell'
      ? await runShellHook(hook, ctx)
      : await runHttpHook(hook, ctx);
  } catch (err) {
    result = { ok: false, durationMs: Date.now() - invokeStart, reason: String(err) };
  }

  const execution: SeedHookExecution = {
    hookKind: hook.kind,
    description,
    lifecyclePoint: ctx.lifecyclePoint,
    ...(ctx.role !== undefined ? { role: ctx.role } : {}),
    ...result,
  };

  if (execution.ok) {
    log.info('seed: hook complete', {
      lifecyclePoint: ctx.lifecyclePoint, kind: hook.kind, ok: true,
      durationMs: execution.durationMs,
      ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
      ...(execution.status !== undefined ? { status: execution.status } : {}),
    });
  } else {
    log.error('seed: hook failed', {
      lifecyclePoint: ctx.lifecyclePoint, kind: hook.kind, reason: execution.reason,
      output: execution.output,
    });
  }

  return execution;
}

/**
 * Run every hook in the array sequentially and return all execution records.
 * When a hook fails and continueOnError is not set, throws immediately after
 * recording the failure — the caller decides whether to abort the run.
 */
export async function runSeedHooksAt(
  hooks: SeedHook[] | undefined,
  ctx: SeedHookContext,
): Promise<SeedHookExecution[]> {
  if (hooks === undefined || hooks.length === 0) return [];

  const executions: SeedHookExecution[] = [];
  for (const hook of hooks) {
    const exec = await runSeedHook(hook, ctx);
    executions.push(exec);
    if (!exec.ok && hook.continueOnError !== true) {
      throw new Error(`seed: ${ctx.lifecyclePoint} hook failed: ${exec.reason ?? 'unknown error'}`);
    }
  }
  return executions;
}

// ---------------------------------------------------------------------------
// Shell executor
// ---------------------------------------------------------------------------

type ShellOutcome = Pick<SeedHookExecution, 'ok' | 'durationMs' | 'exitCode' | 'output' | 'reason'>;

async function runShellHook(hook: Extract<SeedHook, { kind: 'shell' }>, ctx: SeedHookContext): Promise<ShellOutcome> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = hook.cwd ?? ctx.projectDir;
  const env = { ...process.env, ...(hook.env ?? {}) };
  const parts = parseShellCommand(hook.command);
  const [bin, ...args] = parts;
  const start = Date.now();

  return new Promise<ShellOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, durationMs: Date.now() - start, reason: `spawn_error: ${String(err)}` });
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    // stdio is ['ignore', 'pipe', 'pipe'] so stdout/stderr are always set.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STREAM_BYTES) return;
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STREAM_BYTES) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      const reason = err.message.includes('ENOENT')
        ? `command_not_found: ${bin}`
        : `spawn_error: ${err.message}`;
      resolve({ ok: false, durationMs: Date.now() - start, reason });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (timedOut) {
        resolve({ ok: false, durationMs: Date.now() - start, reason: `timeout: hook exceeded ${timeoutMs}ms` });
        return;
      }
      const exitCode = code ?? 1;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const combined = stdout.length > 0 ? stdout : stderr;
      resolve({
        ok: exitCode === 0,
        durationMs: Date.now() - start,
        exitCode,
        output: truncate(combined, OUTPUT_TRUNCATE_CHARS),
        ...(exitCode !== 0 ? { reason: `exit_code: ${exitCode}` } : {}),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP executor
// ---------------------------------------------------------------------------

type HttpOutcome = Pick<SeedHookExecution, 'ok' | 'durationMs' | 'status' | 'output' | 'reason'>;

async function runHttpHook(hook: Extract<SeedHook, { kind: 'http' }>, ctx: SeedHookContext): Promise<HttpOutcome> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = resolveUrl(hook.url, ctx.appBaseUrl);
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  try {
    const headers: Record<string, string> = { ...(hook.headers ?? {}) };
    let body: string | undefined;

    if (hook.body !== undefined) {
      body = typeof hook.body === 'string' ? hook.body : JSON.stringify(hook.body);
      if (!('content-type' in headers) && !('Content-Type' in headers)) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, {
      method: hook.method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const text = await response.text().catch(() => '');
    const ok = isStatusOk(response.status, hook.expectedStatus);

    return {
      ok,
      durationMs: Date.now() - start,
      status: response.status,
      output: truncate(text, OUTPUT_TRUNCATE_CHARS),
      ...(!ok ? { reason: `http_status: ${response.status}` } : {}),
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      durationMs: Date.now() - start,
      reason: isTimeout ? `timeout: hook exceeded ${timeoutMs}ms` : `fetch_error: ${String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a URL: if relative (no scheme), prefix with appBaseUrl.
 * Throws if the URL is relative and no appBaseUrl is configured.
 */
function resolveUrl(url: string, appBaseUrl: string | undefined): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (appBaseUrl === undefined || appBaseUrl === '') {
    throw new Error('seed: http hook with relative URL but no appBaseUrl');
  }
  return `${appBaseUrl.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Minimal whitespace-aware shell command splitter.
 * Handles single and double quoted strings. Does NOT invoke a shell interpreter.
 */
export function parseShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts.length > 0 ? parts : [command];
}

/** Check whether `status` falls within the expected set (default 200-299). */
function isStatusOk(status: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return status >= 200 && status <= 299;
  if (typeof expected === 'number') return status === expected;
  return expected.includes(status);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
