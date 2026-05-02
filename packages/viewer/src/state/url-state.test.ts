import { describe, it, expect } from 'vitest';
import { parseUrlState, serialiseUrlState } from './url-state.ts';

function roundTrip(params: URLSearchParams): URLSearchParams {
  return serialiseUrlState(parseUrlState(params));
}

describe('parseUrlState', () => {
  it('returns defaults when params are empty', () => {
    const state = parseUrlState(new URLSearchParams());
    expect(state.filters.kinds).toEqual([]);
    expect(state.filters.roles).toEqual([]);
    expect(state.filters.severities).toEqual([]);
    expect(state.filters.verdicts).toEqual([]);
    expect(state.filters.pageRouteContains).toBe('');
    expect(state.filters.thirdPartyOrGenerated).toBe('include');
    expect(state.search).toBe('');
    expect(state.selectedClusterId).toBeNull();
    expect(state.theme).toBe('auto');
  });

  it('parses kind list', () => {
    const state = parseUrlState(new URLSearchParams('kind=console_error,react_error'));
    expect(state.filters.kinds).toEqual(['console_error', 'react_error']);
  });

  it('parses severity list', () => {
    const state = parseUrlState(new URLSearchParams('severity=major,critical'));
    expect(state.filters.severities).toEqual(['major', 'critical']);
  });

  it('parses search query', () => {
    const state = parseUrlState(new URLSearchParams('search=hydration'));
    expect(state.search).toBe('hydration');
  });

  it('parses selected cluster id', () => {
    const state = parseUrlState(new URLSearchParams('cluster=abc-123'));
    expect(state.selectedClusterId).toBe('abc-123');
  });

  it('parses theme', () => {
    expect(parseUrlState(new URLSearchParams('theme=dark')).theme).toBe('dark');
    expect(parseUrlState(new URLSearchParams('theme=light')).theme).toBe('light');
    expect(parseUrlState(new URLSearchParams('theme=auto')).theme).toBe('auto');
    expect(parseUrlState(new URLSearchParams()).theme).toBe('auto');
  });

  it('parses thirdParty filter', () => {
    expect(parseUrlState(new URLSearchParams('third_party=exclude')).filters.thirdPartyOrGenerated).toBe('exclude');
    expect(parseUrlState(new URLSearchParams('third_party=only')).filters.thirdPartyOrGenerated).toBe('only');
    expect(parseUrlState(new URLSearchParams('third_party=include')).filters.thirdPartyOrGenerated).toBe('include');
  });
});

describe('serialiseUrlState', () => {
  it('omits keys when using defaults', () => {
    const state = parseUrlState(new URLSearchParams());
    const params = serialiseUrlState(state);
    expect(params.toString()).toBe('');
  });

  it('serialises kind list', () => {
    const state = parseUrlState(new URLSearchParams('kind=console_error,react_error'));
    const params = serialiseUrlState(state);
    expect(params.get('kind')).toBe('console_error,react_error');
  });

  it('serialises selected cluster', () => {
    const state = parseUrlState(new URLSearchParams('cluster=abc'));
    const params = serialiseUrlState(state);
    expect(params.get('cluster')).toBe('abc');
  });
});

describe('round-trip', () => {
  it('round-trips kind + severity + search + cluster', () => {
    const original = new URLSearchParams('kind=console_error&severity=major,critical&search=hydration&cluster=c1');
    const params = roundTrip(original);
    expect(params.get('kind')).toBe('console_error');
    expect(params.get('severity')).toBe('major,critical');
    expect(params.get('search')).toBe('hydration');
    expect(params.get('cluster')).toBe('c1');
  });

  it('round-trips thirdParty=exclude', () => {
    const original = new URLSearchParams('third_party=exclude');
    const params = roundTrip(original);
    expect(params.get('third_party')).toBe('exclude');
  });

  it('round-trips theme=dark', () => {
    const original = new URLSearchParams('theme=dark');
    const params = roundTrip(original);
    expect(params.get('theme')).toBe('dark');
  });
});
