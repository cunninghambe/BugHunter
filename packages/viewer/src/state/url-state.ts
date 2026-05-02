import { useState, useEffect, useCallback } from 'react';
import type { BugKind, ClusterVerdict, Severity } from '../types.ts';
import type { FilterState } from './filters.ts';

// ---------------------------------------------------------------------------
// URL search-param keys
// ---------------------------------------------------------------------------

const PARAM = {
  kinds: 'kind',
  roles: 'role',
  severities: 'severity',
  verdicts: 'verdict',
  pageRouteContains: 'route',
  thirdPartyOrGenerated: 'third_party',
  search: 'search',
  cluster: 'cluster',
  theme: 'theme',
} as const;

// ---------------------------------------------------------------------------
// URL state shape
// ---------------------------------------------------------------------------

export type UrlState = {
  filters: FilterState;
  search: string;
  selectedClusterId: string | null;
  theme: 'auto' | 'light' | 'dark';
};

// ---------------------------------------------------------------------------
// Serialise / deserialise
// ---------------------------------------------------------------------------

function parseList<T extends string>(raw: string | null): T[] {
  if (raw === null || raw === '') return [];
  return raw.split(',').filter(Boolean) as T[];
}

function serialiseList(values: string[]): string {
  return values.join(',');
}

export function parseUrlState(params: URLSearchParams): UrlState {
  const thirdPartyRaw = params.get(PARAM.thirdPartyOrGenerated);
  const thirdParty: FilterState['thirdPartyOrGenerated'] =
    thirdPartyRaw === 'exclude' ? 'exclude'
    : thirdPartyRaw === 'only' ? 'only'
    : 'include';

  const themeRaw = params.get(PARAM.theme);
  const theme: UrlState['theme'] =
    themeRaw === 'light' ? 'light'
    : themeRaw === 'dark' ? 'dark'
    : 'auto';

  return {
    filters: {
      kinds: parseList<BugKind>(params.get(PARAM.kinds)),
      roles: parseList<string>(params.get(PARAM.roles)),
      severities: parseList<Severity>(params.get(PARAM.severities)),
      verdicts: parseList<ClusterVerdict>(params.get(PARAM.verdicts)),
      pageRouteContains: params.get(PARAM.pageRouteContains) ?? '',
      thirdPartyOrGenerated: thirdParty,
    },
    search: params.get(PARAM.search) ?? '',
    selectedClusterId: params.get(PARAM.cluster),
    theme,
  };
}

export function serialiseUrlState(state: UrlState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.filters.kinds.length > 0) params.set(PARAM.kinds, serialiseList(state.filters.kinds));
  if (state.filters.roles.length > 0) params.set(PARAM.roles, serialiseList(state.filters.roles));
  if (state.filters.severities.length > 0) params.set(PARAM.severities, serialiseList(state.filters.severities));
  if (state.filters.verdicts.length > 0) params.set(PARAM.verdicts, serialiseList(state.filters.verdicts));
  if (state.filters.pageRouteContains !== '') params.set(PARAM.pageRouteContains, state.filters.pageRouteContains);
  if (state.filters.thirdPartyOrGenerated !== 'include') params.set(PARAM.thirdPartyOrGenerated, state.filters.thirdPartyOrGenerated);
  if (state.search !== '') params.set(PARAM.search, state.search);
  if (state.selectedClusterId !== null) params.set(PARAM.cluster, state.selectedClusterId);
  if (state.theme !== 'auto') params.set(PARAM.theme, state.theme);

  return params;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useUrlState(): [UrlState, (updater: (prev: UrlState) => UrlState) => void] {
  const [state, setState] = useState<UrlState>(() =>
    parseUrlState(new URLSearchParams(window.location.search)),
  );

  // Sync browser back/forward navigation.
  useEffect(() => {
    const handler = () => {
      setState(parseUrlState(new URLSearchParams(window.location.search)));
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const update = useCallback((updater: (prev: UrlState) => UrlState) => {
    setState(prev => {
      const next = updater(prev);
      const params = serialiseUrlState(next);
      const search = params.toString();
      const newUrl = search !== '' ? `?${search}` : window.location.pathname;
      window.history.pushState(null, '', newUrl);
      return next;
    });
  }, []);

  return [state, update];
}
