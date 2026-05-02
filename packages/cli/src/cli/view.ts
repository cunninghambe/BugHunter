// bughunter view — serves the bundled web UI on a free localhost port.

import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type ViewOptions = {
  port?: number;
  noOpen?: boolean;
  mcp?: string;
  run?: string;
};

export async function runViewCommand(opts: ViewOptions): Promise<void> {
  const port = opts.port ?? await getFreePort();
  const distDir = path.resolve(__dirname, '..', '..', 'viewer-dist');

  if (!fs.existsSync(distDir)) {
    throw new Error(`Viewer assets not found at ${distDir}. Run 'npm run build' in packages/viewer first.`);
  }

  const server = http.createServer((req, res) => {
    serveStatic(distDir, req, res);
  });

  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });

  const searchParams = buildSearchParams(opts);
  const url = `http://127.0.0.1:${port}/${searchParams}`;

  log.info(`Web UI viewer ready at ${url}`);

  const isRemote = process.env['SSH_TTY'] !== undefined || opts.noOpen === true;
  if (isRemote) {
    process.stdout.write(`\nWeb UI viewer running at ${url}\n`);
    if (process.env['SSH_TTY'] !== undefined) {
      process.stdout.write([
        'This appears to be a remote / headless session. To view from your laptop:',
        `  ssh -L ${port}:127.0.0.1:${port} you@this-host`,
        `Then open http://127.0.0.1:${port}/ in your laptop's browser.\n`,
      ].join('\n'));
    }
  } else {
    try {
      await openBrowser(url);
    } catch {
      process.stdout.write(`\nCould not launch a browser automatically. Open this URL manually: ${url}\n`);
    }
  }

  // Stay alive until SIGINT.
  await new Promise<never>(() => {});
}

function buildSearchParams(opts: ViewOptions): string {
  const params = new URLSearchParams();
  if (opts.mcp !== undefined) params.set('mcp', opts.mcp);
  if (opts.run !== undefined) params.set('run', opts.run);
  const qs = params.toString();
  return qs !== '' ? `?${qs}` : '';
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(err => {
        if (err !== undefined) reject(err);
        else resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function serveStatic(
  distDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const rawUrl = req.url ?? '/';

  // Path-traversal rejection: any URL containing '..' is rejected.
  if (rawUrl.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  let urlPath = rawUrl.split('?')[0] ?? '/';
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(distDir, urlPath);

  // Ensure file is inside distDir (belt-and-suspenders after '..' check)
  if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback — serve index.html for unrecognised paths
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

async function openBrowser(url: string): Promise<void> {
  // Use dynamic import to avoid bundling issues
  const { default: open } = await import('open');
  await open(url);
}
