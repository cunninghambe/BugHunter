import { describe, it, expect } from 'vitest';
import { classifyNetworkRequests, isMutatorSyntheticPath } from './network.js';

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
