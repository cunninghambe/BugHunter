// Post-build: copy packages/viewer/dist into packages/cli/viewer-dist.
// Runs after `tsc` as part of `npm run build`.

import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerDist = path.resolve(__dirname, '../viewer/dist');
const dest = path.resolve(__dirname, 'viewer-dist');

if (!existsSync(viewerDist)) {
  console.warn(
    `[build.mjs] packages/viewer/dist not found — skipping viewer-dist copy.\n` +
    `Run 'cd packages/viewer && npm run build' first to include the web UI.`,
  );
} else {
  cpSync(viewerDist, dest, { recursive: true });
  console.log(`[build.mjs] Copied viewer dist → ${dest}`);
}
