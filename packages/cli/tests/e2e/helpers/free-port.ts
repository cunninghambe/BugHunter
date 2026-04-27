import * as net from 'node:net';

/** Returns a free ephemeral port by binding to port 0 and releasing it. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(err => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

/**
 * Finds a free port in the range [min, max] (inclusive) by attempting to bind
 * sequentially until one succeeds. Used for SurfaceMCP which requires 3102-3199.
 */
export function getFreePortInRange(min: number, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let current = min;

    function tryNext(): void {
      if (current > max) {
        reject(new Error(`No free port found in range ${min}-${max}`));
        return;
      }
      const port = current++;
      const server = net.createServer();
      server.once('error', tryNext);
      server.listen(port, '127.0.0.1', () => {
        server.close(err => (err ? tryNext() : resolve(port)));
      });
    }

    tryNext();
  });
}
