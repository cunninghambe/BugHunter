import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const SURFACEMCP_BIN = '/root/SurfaceMCP/dist/cli/main.js';
const BUGHUNTER_BIN = path.resolve('/root/BugHunter/packages/cli/dist/cli/main.js');

/** Polls a URL until it responds with status < 500, or timeoutMs elapses. */
export async function waitForUrl(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return false;
}

/** Starts the fixture Next.js dev server. Returns the child process. */
export function startNextDev(fixtureDir: string, port: number): ChildProcess {
  return spawn('npm', ['run', 'dev'], {
    cwd: fixtureDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Starts the SurfaceMCP HTTP server against the fixture dir. Returns the child process. */
export function startSurfaceMcp(fixtureDir: string): ChildProcess {
  return spawn('node', [SURFACEMCP_BIN, 'serve'], {
    cwd: fixtureDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Runs `bughunter run` in the given project dir. Resolves with exit code + stdout. */
export function runBugHunter(projectDir: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      'node',
      [BUGHUNTER_BIN, 'run', '--max-bugs', '50', '--max-runtime', '60000'],
      {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', code => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** Sends SIGTERM to a process and waits for it to exit (up to timeoutMs). */
export async function kill(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise(resolve => {
    if (proc.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
    proc.once('close', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}
