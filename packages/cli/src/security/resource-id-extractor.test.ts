// Tests for resource-id extractor (v0.5 §3.1).

import { describe, it, expect } from 'vitest';
import {
  extractIdsFromBody,
  mergeDiscoveredIds,
  decodeDiscoveredIdKey,
} from './resource-id-extractor.js';
import type { DiscoveredIds } from '../types.js';

describe('extractIdsFromBody', () => {
  it('extracts top-level id field', () => {
    const ids = extractIdsFromBody({ id: 'abc123', name: 'Trade 1' });
    expect(ids).toContainEqual({ field: 'id', value: 'abc123' });
  });

  it('extracts nested ids from array of objects', () => {
    const body = { data: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] };
    const ids = extractIdsFromBody(body);
    expect(ids.map(r => r.value)).toContain('1');
    expect(ids.map(r => r.value)).toContain('2');
  });

  it('extracts known domain-specific fields', () => {
    const body = { tradeId: 'trade-99', userId: 'user-42' };
    const ids = extractIdsFromBody(body);
    expect(ids).toContainEqual({ field: 'tradeId', value: 'trade-99' });
    expect(ids).toContainEqual({ field: 'userId', value: 'user-42' });
  });

  it('converts numeric ids to string', () => {
    const ids = extractIdsFromBody({ id: 5 });
    expect(ids).toContainEqual({ field: 'id', value: '5' });
  });

  it('ignores non-id fields', () => {
    const ids = extractIdsFromBody({ title: 'hello', description: 'world' });
    expect(ids).toHaveLength(0);
  });

  it('respects maxDepth (stops recursion)', () => {
    // depth=1 means only top-level; nested obj will not be walked
    const body = { outer: { id: 'deep-id' } };
    const ids = extractIdsFromBody(body, 1);
    expect(ids.map(r => r.value)).not.toContain('deep-id');
  });

  it('handles null, undefined, and primitives gracefully', () => {
    expect(extractIdsFromBody(null)).toEqual([]);
    expect(extractIdsFromBody(undefined)).toEqual([]);
    expect(extractIdsFromBody('string')).toEqual([]);
    expect(extractIdsFromBody(42)).toEqual([]);
  });
});

describe('mergeDiscoveredIds', () => {
  it('adds new role and field entries', () => {
    const map: DiscoveredIds = new Map();
    mergeDiscoveredIds(map, 'owner', 'getTrade', [{ field: 'id', value: 'trade-1' }]);
    expect(map.has('owner')).toBe(true);
    expect(map.get('owner')?.get('getTrade:id')?.has('trade-1')).toBe(true);
  });

  it('accumulates multiple values for same field', () => {
    const map: DiscoveredIds = new Map();
    mergeDiscoveredIds(map, 'owner', 'getTrade', [{ field: 'id', value: 'trade-1' }]);
    mergeDiscoveredIds(map, 'owner', 'getTrade', [{ field: 'id', value: 'trade-2' }]);
    const set = map.get('owner')?.get('getTrade:id');
    expect(set?.size).toBe(2);
  });

  it('keys by toolId to avoid field name collisions across tools', () => {
    const map: DiscoveredIds = new Map();
    mergeDiscoveredIds(map, 'owner', 'toolA', [{ field: 'id', value: 'a-1' }]);
    mergeDiscoveredIds(map, 'owner', 'toolB', [{ field: 'id', value: 'b-1' }]);
    const roleMap = map.get('owner')!;
    expect(roleMap.has('toolA:id')).toBe(true);
    expect(roleMap.has('toolB:id')).toBe(true);
  });

  it('is a no-op when ids array is empty', () => {
    const map: DiscoveredIds = new Map();
    mergeDiscoveredIds(map, 'owner', 'getTrade', []);
    expect(map.size).toBe(0);
  });
});

describe('decodeDiscoveredIdKey', () => {
  it('decodes composite key correctly', () => {
    expect(decodeDiscoveredIdKey('getTrade:id')).toEqual({ toolId: 'getTrade', field: 'id' });
  });

  it('handles keys with colons in toolId (takes first colon as separator)', () => {
    expect(decodeDiscoveredIdKey('ns:tool:field')).toEqual({ toolId: 'ns', field: 'tool:field' });
  });

  it('handles missing colon', () => {
    expect(decodeDiscoveredIdKey('notokenhere')).toEqual({ toolId: 'notokenhere', field: '' });
  });
});
