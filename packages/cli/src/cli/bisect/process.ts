// v0.35: app-process spawn / wait-for-port / kill for bughunter bisect.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

const DEFAULT_APP_READY_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const PORT_RELEASE_WAIT_MS = 2_000;
const ORPHAN_CHECK_DELAY_MS = 5_000;

export type SpawnedApp = {
  process: ChildProcess;
  pid: number;
  logPath: string;
};

/** Run a build command in the worktree, writing output to logPath. Returns exit code. */
export function runBuild(
  buildCommand: string,
  worktreeDir: string,
  logPath: string,
  timeoutMs: number,
): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  try {
    const result = spawnSync(buildCommand, [], {
      cwd: worktreeDir,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      timeout: timeoutMs,
    });
    return result.status ?? 1;
  } finally {
    fs.closeSync(logFd);
  }
}

/** Spawn the app process, returning the spawned process handle. */
export function spawnApp(
  appCommand: string,
  worktreeDir: string,
  logPath: string,
  env?: Record<string, string>,
): SpawnedApp {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const proc = spawn(appCommand, [], {
    cwd: worktreeDir,
    shell: true,
    stdio: ['ignore', logStream, logStream],
    detached: false,
    env: { ...process.env, ...(env ?? {}) },
  });

  proc.on('close', () => { try { logStream.close(); } catch { /* ignore */ } });

  const pid = proc.pid ?? 0;
  return { process: proc, pid, logPath };
}

/** Wait for the app's ready URL to respond. Returns true if ready, false if timeout. */
export async function waitForApp(
  readyUrl: string,
  timeoutMs: number = DEFAULT_APP_READY_TIMEOUT_MS,
  proc: ChildProcess,
): Promise<boolean> {
  const url = new URL(readyUrl);
  const port = parseInt(url.port !== '' ? url.port : (url.protocol === 'https:' ? '443' : '80'), 10);
  const hostname = url.hostname;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check process still alive
    if (proc.exitCode !== null) return false;

    const connected = await tryConnect(hostname, port);
    if (connected) return true;

    await sleep(500);
  }
  return false;
}

async function tryConnect(hostname: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: hostname, port });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(400, () => { socket.destroy(); resolve(false); });
  });
}

/** Kill the app process group gracefully (SIGTERM then SIGKILL). */
export async function killApp(
  spawned: SpawnedApp,
  gracePeriodMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<void> {
  const { process: proc, pid } = spawned;
  if (proc.exitCode !== null || pid === 0) return;

  try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  await sleep(gracePeriodMs);
  // SIGKILL if still alive after grace period
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead — expected */ }
}

/** Wait up to PORT_RELEASE_WAIT_MS for the port to be released after kill. */
export async function waitForPortRelease(port: number, hostname: string): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_WAIT_MS;
  while (Date.now() < deadline) {
    const inUse = await tryConnect(hostname, port);
    if (!inUse) return;
    await sleep(200);
  }
}

/** Check if the process is still alive N ms after spawn (orphan detection). */
export async function checkNotDaemonized(proc: ChildProcess): Promise<boolean> {
  await sleep(ORPHAN_CHECK_DELAY_MS);
  // If the process exited very quickly after spawn, it may have daemonized
  return proc.exitCode === null;
}

/** Run reset commands in the worktree sequentially. */
export function runResetCommands(commands: string[], worktreeDir: string, logPath: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  try {
    for (const cmd of commands) {
      try {
        spawnSync(cmd, [], { cwd: worktreeDir, shell: true, stdio: ['ignore', logFd, logFd] });
      } catch { /* best effort */ }
    }
  } finally {
    fs.closeSync(logFd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Extract port number from a URL string. */
export function portFromUrl(url: string): number {
  try {
    const u = new URL(url);
    if (u.port !== '') return parseInt(u.port, 10);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3000;
  }
}
