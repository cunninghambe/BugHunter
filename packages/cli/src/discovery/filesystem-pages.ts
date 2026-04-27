// AST scan for filesystem-routed pages (§ 3.3).
// Next.js: app/**/page.tsx and pages/**/!(api)/*.tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';

export type FilesystemPage = {
  route: string;
  sourceFile: string;
};

export async function discoverFilesystemPages(projectRoot: string): Promise<FilesystemPage[]> {
  const pages: FilesystemPage[] = [];

  // Next.js App Router: app/**/page.tsx
  const appPages = await glob('app/**/page.{tsx,jsx,ts,js}', {
    cwd: projectRoot,
    nodir: true,
    ignore: ['node_modules/**', '.next/**'],
  });

  for (const file of appPages) {
    const route = appFileToRoute(file);
    pages.push({ route, sourceFile: path.join(projectRoot, file) });
  }

  // Next.js Pages Router: pages/**/*.tsx (not api/ and not _app, _document)
  const pagesDir = await glob('pages/**/*.{tsx,jsx,ts,js}', {
    cwd: projectRoot,
    nodir: true,
    ignore: ['pages/api/**', 'pages/_app.*', 'pages/_document.*', 'node_modules/**'],
  });

  for (const file of pagesDir) {
    const route = pagesFileToRoute(file);
    pages.push({ route, sourceFile: path.join(projectRoot, file) });
  }

  // Deduplicate by route
  const seen = new Set<string>();
  return pages.filter(p => {
    if (seen.has(p.route)) return false;
    seen.add(p.route);
    return true;
  });
}

// app/admin/products/page.tsx -> /admin/products
// app/(group)/products/page.tsx -> /products  (route groups stripped)
// app/[id]/page.tsx -> /[id]
function appFileToRoute(file: string): string {
  // Remove leading "app/" and trailing "/page.tsx"
  let route = file.replace(/^app\//, '').replace(/\/page\.[jt]sx?$/, '');
  // Remove route groups (parenthesized segments)
  route = route.replace(/\([^)]+\)\//g, '');
  if (!route) return '/';
  // Normalize dynamic segments: [id] stays as [id]
  return '/' + route;
}

// pages/admin/products/index.tsx -> /admin/products
// pages/admin/products.tsx -> /admin/products
function pagesFileToRoute(file: string): string {
  let route = file.replace(/^pages\//, '').replace(/\.[jt]sx?$/, '');
  if (route === 'index') return '/';
  route = route.replace(/\/index$/, '');
  return '/' + route;
}

export function isDynamicRoute(route: string): boolean {
  return /\[.+\]/.test(route) || /:[A-Za-z_][\w]*/.test(route) || route.includes('*');
}

export function expandDynamicRoute(
  route: string,
  fixtures: Record<string, string[]>
): string[] {
  if (!isDynamicRoute(route)) return [route];
  const ids = fixtures[route];
  if (!ids || ids.length === 0) return [];
  return ids.map(id => {
    let r = route.replace(/\[([^\]]+)\]/g, id); // Next.js style [param]
    r = r.replace(/:[A-Za-z_][\w]*/g, id);       // React Router style :param
    r = r.replace(/\*/g, id);                    // Splat *
    return r;
  });
}

export function doesProjectDirExist(projectRoot: string): boolean {
  return fs.existsSync(projectRoot);
}
