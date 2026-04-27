// Table-driven tests for normalizeLink and routeKey — SPEC_CRAWLER § 5.2 + § 5.3

import { describe, it, expect } from 'vitest';
import { normalizeLink, routeKey } from '../src/discovery/crawler.js';

const BASE = 'http://h:1';
const CURRENT = 'http://h:1/';

type NormalizeRow = {
  href: string;
  currentUrl: string;
  followQueryParams: boolean;
  sameOriginOnly: boolean;
  expected: string | null;
};

const normalizeTable: NormalizeRow[] = [
  { href: '/about',              currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/about' },
  { href: 'about',               currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/about' },
  { href: './x',                 currentUrl: 'http://h:1/dir/', followQueryParams: false, sameOriginOnly: true, expected: 'http://h:1/dir/x' },
  { href: '../x',                currentUrl: 'http://h:1/dir/sub/', followQueryParams: false, sameOriginOnly: true, expected: 'http://h:1/dir/x' },
  { href: '/x?a=1',             currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/x' },
  { href: '/x?a=1',             currentUrl: CURRENT, followQueryParams: true,  sameOriginOnly: true,  expected: 'http://h:1/x?a=1' },
  { href: '/x#hash',            currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/x' },
  { href: '#hash',               currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: null },
  { href: 'https://other/',     currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: null },
  { href: 'https://other/',     currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: false, expected: 'https://other/' },
  { href: 'javascript:void(0)', currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: null },
  { href: 'mailto:a@b',         currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: null },
  { href: '',                    currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: null },
  { href: '/about/',             currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/about' },
  { href: '/',                   currentUrl: CURRENT, followQueryParams: false, sameOriginOnly: true,  expected: 'http://h:1/' },
];

describe('normalizeLink — table (§ 5.2)', () => {
  for (const row of normalizeTable) {
    it(`normalizeLink(${JSON.stringify(row.href)}, fqp=${row.fqp ?? row.followQueryParams}, sameOrigin=${row.sameOriginOnly}) → ${row.expected}`, () => {
      const result = normalizeLink(row.href, row.currentUrl, {
        baseUrl: BASE,
        followQueryParams: row.followQueryParams,
        sameOriginOnly: row.sameOriginOnly,
      });
      expect(result).toBe(row.expected);
    });
  }
});

type RouteKeyRow = {
  url: string;
  followQueryParams: boolean;
  expected: string;
};

const routeKeyTable: RouteKeyRow[] = [
  { url: 'http://h:1/',            followQueryParams: false, expected: '/' },
  { url: 'http://h:1/about',       followQueryParams: false, expected: '/about' },
  { url: 'http://h:1/about/',      followQueryParams: false, expected: '/about' },
  { url: 'http://h:1/about?b=2&a=1', followQueryParams: true,  expected: '/about?a=1&b=2' },
  { url: 'http://h:1/about?b=2&a=1', followQueryParams: false, expected: '/about' },
  { url: 'http://h:1/about#sec',   followQueryParams: false, expected: '/about' },
];

describe('routeKey — table (§ 5.3)', () => {
  for (const row of routeKeyTable) {
    it(`routeKey(${row.url}, fqp=${row.followQueryParams}) → ${row.expected}`, () => {
      const result = routeKey(new URL(row.url), row.followQueryParams);
      expect(result).toBe(row.expected);
    });
  }
});
