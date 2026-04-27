// Regression snapshot: pins the Next.js fixture page set to detect any regressions
// in discoverFilesystemPages from v0.1 behavior (spec § 7.3).

import { describe, it, expect } from 'vitest';
import { discoverFilesystemPages } from '../src/discovery/filesystem-pages.js';

const EXPECTED = [
  '/admin/inline-action',
  '/admin/orders',
  '/admin/users',
  '/api/missing-route-link',
  '/dom-test',
  '/dual-404-link',
  '/journal',
  '/policies/privacy',
];

describe('Next.js page discovery snapshot', () => {
  it('produces the same set as v0.1', async () => {
    const fixtureRoot = '/root/SurfaceMCP/fixtures/nextjs-app';
    const pages = await discoverFilesystemPages(fixtureRoot);
    const got = pages.map(p => p.route).sort();
    expect(got).toEqual(EXPECTED.slice().sort());
  });
});
