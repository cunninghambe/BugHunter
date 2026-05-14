// Unit tests for path-placeholder detection (v0.51).
//
// Spec: docs/benchmarks/BENCHMARK_SPOONWORKS.md — 20/20 surface_call_failed
// FPs on spoonworks originated from unsubstituted :id placeholders.

import { describe, it, expect } from 'vitest';
import {
  findUnresolvedPlaceholder,
  hasUnresolvedPlaceholder,
  listUnresolvedPlaceholders,
} from './path-placeholder.js';

describe('hasUnresolvedPlaceholder — positive cases', () => {
  it('detects :id at the end of path', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/products/:id')).toBe(true);
  });

  it('detects :id in the middle of path', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/products/:id/adjust-stock')).toBe(true);
  });

  it('detects camelCase param :productId', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/recipes/:productId')).toBe(true);
  });

  it('detects snake_case param :user_id', () => {
    expect(hasUnresolvedPlaceholder('/api/v2/:user_id/profile')).toBe(true);
  });

  it('detects multiple placeholders in same path', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/products/:id/images/:index')).toBe(true);
  });
});

describe('hasUnresolvedPlaceholder — negative cases (no FP)', () => {
  it('returns false for a fully-resolved path with numeric id', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/products/123/adjust-stock')).toBe(false);
  });

  it('returns false for a fully-resolved path with cuid', () => {
    expect(hasUnresolvedPlaceholder('/api/admin/products/cmo8njs7x002r6ksdr062vvvp/adjust-stock')).toBe(false);
  });

  it('returns false for a root path', () => {
    expect(hasUnresolvedPlaceholder('/')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasUnresolvedPlaceholder('')).toBe(false);
  });

  it('returns false for a path with port colon (URL prefix not a placeholder)', () => {
    // The regex requires /:placeholder, so a URL like http://host:3000/api won't match.
    // We don't normally pass full URLs through this, but defensively verify.
    expect(hasUnresolvedPlaceholder('http://localhost:3000/api/products')).toBe(false);
  });

  it('returns false when path is just /:id at root (still detects — make sure pattern is correct)', () => {
    // Edge case: a path like /:id alone is unusual but valid Express syntax.
    expect(hasUnresolvedPlaceholder('/:id')).toBe(true);
  });
});

describe('findUnresolvedPlaceholder', () => {
  it('returns the first placeholder including leading slash', () => {
    expect(findUnresolvedPlaceholder('/api/admin/products/:id/images/:index')).toBe('/:id');
  });

  it('returns null when no placeholder', () => {
    expect(findUnresolvedPlaceholder('/api/admin/products/123')).toBeNull();
  });

  it('captures the param name without the leading slash via match group', () => {
    // listUnresolvedPlaceholders strips the slash; find returns it.
    expect(findUnresolvedPlaceholder('/api/:userId')).toBe('/:userId');
  });
});

describe('listUnresolvedPlaceholders', () => {
  it('returns empty array for fully-resolved path', () => {
    expect(listUnresolvedPlaceholders('/api/products/123')).toEqual([]);
  });

  it('returns single-element array for one placeholder', () => {
    expect(listUnresolvedPlaceholders('/api/products/:id')).toEqual([':id']);
  });

  it('returns multiple placeholders preserving order', () => {
    expect(listUnresolvedPlaceholders('/api/products/:id/images/:index')).toEqual([':id', ':index']);
  });

  it('returns the param names without the leading slash', () => {
    const result = listUnresolvedPlaceholders('/api/:a/:b/:c');
    expect(result).toEqual([':a', ':b', ':c']);
  });
});

describe('regression: spoonworks-class real routes from benchmark', () => {
  // From docs/benchmarks/BENCHMARK_SPOONWORKS.md — these routes produced 20/20
  // FPs before this fix. All must detect as having a placeholder.
  const SPOONWORKS_FP_ROUTES = [
    '/api/admin/products/:id/adjust-stock',
    '/api/admin/orders/:id/shipping/return',
    '/api/admin/ingredients/:id/restock',
    '/api/admin/orders/:id/shipping/rates',
    '/api/admin/orders/:id/shipping/buy',
    '/api/admin/promo-codes/:id',
    '/api/admin/products/:id/images/:index',
    '/api/admin/batches/:id',
    '/api/admin/promo-codes/:id/stats',
    '/api/admin/shipping/labels/:id/void',
    '/api/admin/shipping/labels/:id/download',
    '/api/admin/recipes/:productId',
    '/api/admin/alerts/oversell/:id/resolve',
    '/api/admin/tax-deadlines/:id/pay',
  ];

  it.each(SPOONWORKS_FP_ROUTES)('detects placeholder in %s', (route) => {
    expect(hasUnresolvedPlaceholder(route)).toBe(true);
  });
});
