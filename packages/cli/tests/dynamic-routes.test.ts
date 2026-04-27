// Tests for isDynamicRoute + expandDynamicRoute — spec § 6.3
// Covers both Next.js [param] and React Router :param syntax.

import { describe, it, expect } from 'vitest';
import { isDynamicRoute, expandDynamicRoute } from '../src/discovery/filesystem-pages.js';

describe('isDynamicRoute', () => {
  it.each([
    ['/users/[id]', true],
    ['/users/:id', true],
    ['/users/*', true],
    ['/about', false],
    ['/', false],
    ['/admin/users', false],
    ['/users/:postId/comments/:commentId', true],
  ])('%s → %s', (route, expected) => {
    expect(isDynamicRoute(route)).toBe(expected);
  });
});

describe('expandDynamicRoute', () => {
  it('expands Next.js [id] style', () => {
    const result = expandDynamicRoute('/users/[id]', { '/users/[id]': ['42'] });
    expect(result).toEqual(['/users/42']);
  });

  it('expands React Router :id style', () => {
    const result = expandDynamicRoute('/users/:id', { '/users/:id': ['42'] });
    expect(result).toEqual(['/users/42']);
  });

  it('expands splat * style', () => {
    const result = expandDynamicRoute('/users/*', { '/users/*': ['42'] });
    expect(result).toEqual(['/users/42']);
  });

  it('returns [] for missing fixture entry', () => {
    const result = expandDynamicRoute('/users/:id', {});
    expect(result).toEqual([]);
  });

  it('returns route unchanged for static routes', () => {
    const result = expandDynamicRoute('/about', {});
    expect(result).toEqual(['/about']);
  });

  it('expands multiple values', () => {
    const result = expandDynamicRoute('/users/:id', { '/users/:id': ['1', '2', '3'] });
    expect(result).toEqual(['/users/1', '/users/2', '/users/3']);
  });
});
