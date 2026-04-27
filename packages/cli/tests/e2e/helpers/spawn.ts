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
    // detached: spawn in its own process group so we can kill the whole group
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Starts a Vite dev server using `npm run dev` with a custom port via CLI arg. */
export function startViteDev(fixtureDir: string, port: number): ChildProcess {
  return spawn('npm', ['run', 'dev', '--', '--port', String(port)], {
    cwd: fixtureDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Starts the SurfaceMCP HTTP server against the fixture dir. Returns the child process. */
export function startSurfaceMcp(fixtureDir: string): ChildProcess {
  return spawn('node', [SURFACEMCP_BIN, 'serve'], {
    cwd: fixtureDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Runs `bughunter run` in the given project dir.
 * Resolves with exit code, combined stdout/stderr, and the run ID extracted from
 * the "Starting new run <id>" log line (or undefined if not found).
 */
export function runBugHunter(projectDir: string): Promise<{ code: number; stdout: string; runId: string | undefined }> {
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
      const stdout = Buffer.concat(chunks).toString('utf8');
      const match = /Starting new run ([a-z0-9]+)/.exec(stdout);
      resolve({ code: code ?? 1, stdout, runId: match?.[1] });
    });
  });
}

/**
 * Kills a child process and all its descendants by sending SIGKILL to the
 * process group (negative pid). Uses SIGTERM first with a SIGKILL fallback.
 * This is critical for Next.js which spawns worker processes that outlive the
 * parent if only the parent is signaled.
 */
export async function kill(proc: ChildProcess, timeoutMs = 8_000): Promise<void> {
  return new Promise(resolve => {
    if (proc.exitCode !== null) { resolve(); return; }

    const timer = setTimeout(() => {
      try { process.kill(-(proc.pid!), 'SIGKILL'); } catch {}
      resolve();
    }, timeoutMs);

    proc.once('close', () => { clearTimeout(timer); resolve(); });

    // Kill the entire process group
    try {
      process.kill(-(proc.pid!), 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  });
}
