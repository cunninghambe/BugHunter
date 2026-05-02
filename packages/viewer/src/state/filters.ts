import type { BugCluster, BugKind, ClusterVerdict, Severity } from '../types.ts';
import { suspectedFilePath } from '../types.ts';

// ---------------------------------------------------------------------------
// FilterState
// ---------------------------------------------------------------------------

export type FilterState = {
  kinds: BugKind[];
  roles: string[];
  severities: Severity[];
  verdicts: ClusterVerdict[];
  pageRouteContains: string;
  thirdPartyOrGenerated: 'include' | 'exclude' | 'only';
};

export const EMPTY_FILTERS: FilterState = {
  kinds: [],
  roles: [],
  severities: [],
  verdicts: [],
  pageRouteContains: '',
  thirdPartyOrGenerated: 'include',
};

// ---------------------------------------------------------------------------
// applyFilters
// ---------------------------------------------------------------------------

export function applyFilters(
  clusters: BugCluster[],
  filters: FilterState,
  searchQuery: string,
): BugCluster[] {
  const needle = searchQuery.toLowerCase().trim();

  return clusters.filter(cluster => {
    // kind filter
    if (filters.kinds.length > 0 && !filters.kinds.includes(cluster.kind as BugKind)) {
      return false;
    }

    // role filter — cluster matches if any occurrence has a matching role
    if (filters.roles.length > 0) {
      const hasMatchingRole = cluster.occurrences.some(occ => filters.roles.includes(occ.role));
      if (!hasMatchingRole) return false;
    }

    // severity filter — EC-10: absent severity hides cluster when filter is active
    if (filters.severities.length > 0) {
      if (cluster.severity === undefined || !filters.severities.includes(cluster.severity)) {
        return false;
      }
    }

    // verdict filter
    if (filters.verdicts.length > 0) {
      if (cluster.verdict === undefined || !filters.verdicts.includes(cluster.verdict)) {
        return false;
      }
    }

    // pageRoute filter
    if (filters.pageRouteContains !== '') {
      const routeLower = filters.pageRouteContains.toLowerCase();
      const hasMatchingRoute = cluster.occurrences.some(occ =>
        occ.page.toLowerCase().includes(routeLower),
      );
      if (!hasMatchingRoute) return false;
    }

    // thirdParty filter
    if (filters.thirdPartyOrGenerated === 'exclude' && cluster.thirdPartyOrGenerated) {
      return false;
    }
    if (filters.thirdPartyOrGenerated === 'only' && !cluster.thirdPartyOrGenerated) {
      return false;
    }

    // search query — matches against rootCause, kind, page routes, suspectedFiles
    if (needle !== '') {
      const inRootCause = cluster.rootCause.toLowerCase().includes(needle);
      const inKind = cluster.kind.toLowerCase().includes(needle);
      const inPages = cluster.occurrences.some(occ => occ.page.toLowerCase().includes(needle));
      const inFiles = cluster.suspectedFiles.some(f => suspectedFilePath(f).toLowerCase().includes(needle));
      if (!inRootCause && !inKind && !inPages && !inFiles) {
        return false;
      }
    }

    return true;
  });
}
