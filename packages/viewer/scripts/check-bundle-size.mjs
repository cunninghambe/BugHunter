#!/usr/bin/env node
// Bundle-size CI gate: fails if gzipped total > 250KB.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

const MAX_BYTES = 250 * 1024; // 250KB

async function gzipSize(content) {
  const chunks = [];
  const readable = Readable.from([content]);
  const gzip = createGzip({ level: 9 });
  for await (const chunk of readable.pipe(gzip)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).length;
}

function collectFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      const ext = extname(entry);
      if (['.js', '.css', '.html'].includes(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

async function main() {
  const files = collectFiles(distDir);
  let totalGz = 0;
  const rows = [];

  for (const file of files) {
    const content = readFileSync(file);
    const gz = await gzipSize(content);
    totalGz += gz;
    const rel = file.replace(distDir + '/', '');
    rows.push({ path: rel, bytes: gz });
  }

  rows.sort((a, b) => b.bytes - a.bytes);

  console.log('\nBundle size breakdown (gzipped):');
  for (const row of rows) {
    const kb = (row.bytes / 1024).toFixed(1);
    console.log(`  ${kb.padStart(7)}KB  ${row.path}`);
  }

  const totalKb = (totalGz / 1024).toFixed(1);
  console.log(`\nTotal: ${totalKb}KB gzipped (limit: ${MAX_BYTES / 1024}KB)\n`);

  if (totalGz > MAX_BYTES) {
    console.error(`ERROR: Bundle exceeds ${MAX_BYTES / 1024}KB limit (actual: ${totalKb}KB)`);
    process.exit(1);
  }

  console.log('Bundle size check passed.');
}

main().catch(err => {
  console.error('Bundle size check failed:', err);
  process.exit(1);
});
