// Bundle-size analyzer — detects oversized_bundle (§3.2).
// Pure function: scans a dist/ directory and returns BundleArtifact[].

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { BundleArtifact } from '../types.js';

const DEFAULT_JS_THRESHOLD_GZIP = 500 * 1024;   // 500KB
const DEFAULT_CSS_THRESHOLD_GZIP = 200 * 1024;  // 200KB

export type BundleAnalyzerOptions = {
  distPath: string;
  indexHtmlPath?: string;
  jsThresholdGzipBytes?: number;
  cssThresholdGzipBytes?: number;
};

export type BundleAnalyzerResult = {
  artifacts: BundleArtifact[];
  totalInitialJsGzip: number;
  totalInitialCssGzip: number;
  exceedsJsBudget: boolean;
  exceedsCssBudget: boolean;
};

function gzipSize(content: Buffer): number {
  return zlib.gzipSync(content, { level: zlib.constants.Z_DEFAULT_COMPRESSION }).length;
}

function kindFromExt(ext: string): BundleArtifact['kind'] {
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.css') return 'css';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'asset';
}

/** Parse index.html and extract initial-route asset paths. */
function parseInitialRouteAssets(indexHtmlContent: string, distPath: string): Set<string> {
  const initialPaths = new Set<string>();

  // Match: <script src="...">, <link rel="stylesheet" href="...">,
  //        <link rel="modulepreload" href="...">, <link rel="preload" href="...">
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<link[^>]+rel=["'](stylesheet|modulepreload|preload)["'][^>]+href=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](stylesheet|modulepreload|preload)["']/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(indexHtmlContent)) !== null) {
      // Script: group 1. Link: group 2 or 1 (cast needed: noUncheckedIndexedAccess is off)
      const href = (m[2] as string | undefined) ?? (m[1] as string | undefined) ?? '';
      if (href === '') continue;
      // Resolve to an absolute path within distPath
      const stripped = href.replace(/^\//, '');
      const resolved = path.join(distPath, stripped);
      initialPaths.add(resolved);
    }
  }

  return initialPaths;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

export function analyzeBundles(opts: BundleAnalyzerOptions): BundleAnalyzerResult {
  const {
    distPath,
    indexHtmlPath,
    jsThresholdGzipBytes = DEFAULT_JS_THRESHOLD_GZIP,
    cssThresholdGzipBytes = DEFAULT_CSS_THRESHOLD_GZIP,
  } = opts;

  // Parse initial-route assets from index.html
  let initialRoutePaths = new Set<string>();
  const effectiveIndexHtml = indexHtmlPath ?? path.join(distPath, 'index.html');
  if (fs.existsSync(effectiveIndexHtml)) {
    const content = fs.readFileSync(effectiveIndexHtml, 'utf-8');
    initialRoutePaths = parseInitialRouteAssets(content, distPath);
    // Also mark the index.html itself as initial-route
    initialRoutePaths.add(effectiveIndexHtml);
  }

  const allFiles = walkDir(distPath);
  const artifacts: BundleArtifact[] = [];

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    const kind = kindFromExt(ext);
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file);
    const bytesGzipped = gzipSize(content);
    const relativePath = path.relative(distPath, file);

    artifacts.push({
      path: relativePath,
      kind,
      bytesRaw: stat.size,
      bytesGzipped,
      initialRoute: initialRoutePaths.has(file),
    });
  }

  const initialJs = artifacts.filter(a => a.kind === 'js' && a.initialRoute);
  const initialCss = artifacts.filter(a => a.kind === 'css' && a.initialRoute);
  const totalInitialJsGzip = initialJs.reduce((s, a) => s + a.bytesGzipped, 0);
  const totalInitialCssGzip = initialCss.reduce((s, a) => s + a.bytesGzipped, 0);

  return {
    artifacts,
    totalInitialJsGzip,
    totalInitialCssGzip,
    exceedsJsBudget: totalInitialJsGzip > jsThresholdGzipBytes,
    exceedsCssBudget: totalInitialCssGzip > cssThresholdGzipBytes,
  };
}
