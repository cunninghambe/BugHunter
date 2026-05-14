import { describe, it, expect } from 'vitest';
import { classifyNetworkRequests, isMutatorSyntheticPath, isDevServerPath } from './network.js';

describe('isMutatorSyntheticPath', () => {
  it('matches all-zero UUID', () => {
    expect(isMutatorSyntheticPath('/api/items/00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('matches __bughunter_ prefix sentinel', () => {
    expect(isMutatorSyntheticPath('/api/items/__bughunter_nonexistent__')).toBe(true);
  });

  it('matches -nonexistent suffix from foreignIdCases', () => {
    expect(isMutatorSyntheticPath('/api/items/abc-123-nonexistent')).toBe(true);
  });

  it('matches fake-id sentinel', () => {
    expect(isMutatorSyntheticPath('/api/items/fake-id')).toBe(true);
  });

  it('matches synthetic-test-id sentinel', () => {
    expect(isMutatorSyntheticPath('/api/items/synthetic-test-id')).toBe(true);
  });

  it('does not match real paths', () => {
    expect(isMutatorSyntheticPath('/api/items/abc-123')).toBe(false);
    expect(isMutatorSyntheticPath('/api/items/550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isMutatorSyntheticPath('/dashboard')).toBe(false);
  });
});

describe('isDevServerPath (#145)', () => {
  it('matches /@vite/ prefix', () => {
    expect(isDevServerPath('/@vite/client')).toBe(true);
  });

  it('matches /@fs/ prefix', () => {
    expect(isDevServerPath('/@fs/root/path/to/foo.ts')).toBe(true);
  });

  it('matches /node_modules/.vite/ prefix', () => {
    expect(isDevServerPath('/node_modules/.vite/deps/react.js')).toBe(true);
  });

  it('matches /__vite_ping', () => {
    expect(isDevServerPath('/__vite_ping')).toBe(true);
  });

  it('matches /__nuxt/ prefix', () => {
    expect(isDevServerPath('/__nuxt/hmr')).toBe(true);
  });

  it('matches /_next/static/development/ prefix', () => {
    expect(isDevServerPath('/_next/static/development/foo.js')).toBe(true);
  });

  it('does not match /_next/static/chunks/ (production prefix)', () => {
    expect(isDevServerPath('/_next/static/chunks/main.js')).toBe(false);
  });

  it('does not match real API routes', () => {
    expect(isDevServerPath('/api/users')).toBe(false);
    expect(isDevServerPath('/dashboard')).toBe(false);
  });
});

describe('classifyNetworkRequests — network_5xx dev-server suppression (#145)', () => {
  it('emits network_5xx for a real route 5xx', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/users', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === 'network_5xx')).toBe(true);
  });

  it('suppresses network_5xx for /@vite/client 5xx', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/@vite/client', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== 'network_5xx')).toBe(true);
  });

  it('suppresses network_5xx for /@fs/ path 5xx', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/@fs/root/path/to/foo.ts', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== 'network_5xx')).toBe(true);
  });

  it('suppresses network_5xx for /node_modules/.vite/ path 5xx', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/node_modules/.vite/deps/react.js', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== 'network_5xx')).toBe(true);
  });

  it('suppresses network_5xx for /_next/static/development/ path 5xx', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/_next/static/development/foo.js', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== 'network_5xx')).toBe(true);
  });

  it('emits network_5xx for /_next/static/chunks/ (production prefix)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/_next/static/chunks/main.js', status: 500, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === 'network_5xx')).toBe(true);
  });

  it('emits network_5xx for /api/users real route', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/users', status: 503, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === 'network_5xx')).toBe(true);
  });
});

describe('classifyNetworkRequests — 404_for_linked_route suppression (#112)', () => {
  it('suppresses 404_for_linked_route when path contains mutator all-zero UUID', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/orders/00000000-0000-0000-0000-000000000000', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for __bughunter_ sentinel paths', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/products/__bughunter_nonexistent__', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for fake-id sentinel', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/users/fake-id/profile', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for synthetic-test-id sentinel', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/users/synthetic-test-id', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('emits 404_for_linked_route when path is a real link (not mutator-synthesized)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/orders/550e8400-e29b-41d4-a716-446655440000', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === '404_for_linked_route')).toBe(true);
  });

  it('emits 404_for_linked_route for a plain missing page path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/settings/billing', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === '404_for_linked_route')).toBe(true);
  });

  it('does not emit 404_for_linked_route when mutator URL returns 200', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/api/items/00000000-0000-0000-0000-000000000000', status: 200, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
    expect(bugs).toHaveLength(0);
  });
});

describe('classifyNetworkRequests — 404_for_linked_route dev-server suppression (#149 follow-up)', () => {
  it('emits 404_for_linked_route for a real route 404', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/settings/billing', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /@vite/ path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/@vite/client', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /@fs/ path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/@fs/root/path/to/foo.ts', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /node_modules/.vite/ path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/node_modules/.vite/deps/react.js', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /__vite_ping', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/__vite_ping', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /__nuxt/ path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/__nuxt/hmr', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('suppresses 404_for_linked_route for /_next/static/development/ path', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/_next/static/development/foo.js', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== '404_for_linked_route')).toBe(true);
  });

  it('emits 404_for_linked_route for /_next/static/chunks/ (production prefix)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'GET', path: '/_next/static/chunks/main.js', status: 404, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === '404_for_linked_route')).toBe(true);
  });
});

describe('classifyNetworkRequests — v0.51 422 suppression for happy palette', () => {
  it('drops 422 entirely when expectedOutcome is success (BugHunter input synth failure)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/products', status: 422, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.every(b => b.kind !== 'network_4xx_unexpected')).toBe(true);
  });

  it('drops 422 even when responseBodySnippet is empty (snippet capture not reliable)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/orders', status: 422, duration: 10, responseBodySnippet: '' }],
      'success',
      true,
    );
    expect(bugs.length).toBe(0);
  });

  it('drops 422 when responseBodySnippet does NOT contain a Zod marker (previous rule missed these)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/products', status: 422, duration: 10, responseBodySnippet: '{"error":"bad request"}' }],
      'success',
      true,
    );
    expect(bugs.length).toBe(0);
  });

  it('still emits non-422 4xx (e.g. 400) on happy palette', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/products', status: 400, duration: 10 }],
      'success',
      true,
    );
    expect(bugs.some(b => b.kind === 'network_4xx_unexpected' && b.status === 400)).toBe(true);
  });

  it('does not fire on 422 with expected_failure palette (mutator probes expecting failure)', () => {
    const bugs = classifyNetworkRequests(
      [{ method: 'POST', path: '/api/x', status: 422, duration: 10 }],
      'expected_failure',
      true,
    );
    expect(bugs.length).toBe(0);
  });
});
