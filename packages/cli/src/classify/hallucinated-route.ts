// V25: Hallucinated-route detector — emits hallucinated_route for filesystem-routed
// pages that return 404 on their own page navigation.

import type { BugDetection, DiscoveredPage, TestResult } from '../types.js';

export type HallucinatedRouteInput = {
  /** Render TestResults only (filter on action.kind === 'render' before passing in). */
  renderResults: TestResult[];
  /** The discovery output's pages list — gives us sourceFile / navSource per route. */
  pages: DiscoveredPage[];
  /** Routes excluded from hallucinated-route detection (configured discoveryFixtures whose row is missing). */
  fixtureUnresolvableRoutes: Set<string>;
};

export type HallucinatedRouteOutput = {
  perTestId: Map<string, {
    add: BugDetection[];
    removePredicate: (d: BugDetection) => boolean;
  }>;
};

/**
 * Detect planner-discovered pages that return 404 on their own page navigation.
 *
 * Returns a map of testId → { add, removePredicate } so the caller can:
 * 1. Remove the matching 404_for_linked_route detection for the page URL (disambiguation)
 * 2. Add the hallucinated_route detection
 *
 * Page route is read from postState.url (set to tc.page in executeUiTestInner).
 *
 * Qualifies pages by:
 * - sourceFile is set (filesystem-routed), OR
 * - navSource is 'static-page' or undefined (surface_list_pages-sourced)
 *
 * Skips:
 * - Routes in fixtureUnresolvableRoutes (dynamic route with missing fixture)
 * - Pages with kind === 'state' (no real URL to render against)
 * - Pages with no postState or empty networkRequests (perf disabled)
 */
export function detectHallucinatedRoutes(
  input: HallucinatedRouteInput,
): HallucinatedRouteOutput {
  const { renderResults, pages, fixtureUnresolvableRoutes } = input;
  const pageByRoute = new Map<string, DiscoveredPage>(pages.map(p => [p.route, p]));
  const perTestId = new Map<string, { add: BugDetection[]; removePredicate: (d: BugDetection) => boolean }>();

  for (const result of renderResults) {
    const { postState } = result;
    if (postState === undefined) continue;

    const pageRoute = postState.url;
    if (pageRoute === '') continue;

    if (postState.networkRequests.length === 0) continue;

    const page = pageByRoute.get(pageRoute);
    if (page === undefined) continue;

    // EC-HR-3: skip state-kind pages (no real URL to render against)
    if (page.kind === 'state') continue;

    // Skip 1: route expanded from a discoveryFixture with missing row
    if (fixtureUnresolvableRoutes.has(pageRoute)) continue;

    // Skip 2: only filesystem-routed or surface_list_pages routes qualify
    // (crawl-link / crawl-seed 404s are already handled by 404_for_linked_route)
    const isFilesystemRouted = page.sourceFile !== undefined && page.sourceFile !== '';
    const isStaticListed = page.navSource === 'static-page' || page.navSource === undefined;
    if (!isFilesystemRouted && !isStaticListed) continue;

    // Detection: did the page navigation itself return 404?
    const pageRequest = postState.networkRequests.find(
      r => r.method === 'GET' && pathsMatch(r.path, pageRoute)
    );
    if (pageRequest?.status !== 404) continue;

    const detection: BugDetection = {
      kind: 'hallucinated_route',
      rootCause: `Planner-discovered page ${pageRoute} returned 404 — route does not exist on the server`,
      targetPath: pageRoute,
      pageRoute,
    };

    // removePredicate: disambiguate from 404_for_linked_route for the same URL.
    // The caller removes the 404_for_linked_route detection and adds hallucinated_route
    // so there is one detection per cause.
    const capturedRoute = pageRoute;
    const removePredicate = (d: BugDetection): boolean =>
      d.kind === '404_for_linked_route' && d.targetPath === capturedRoute;

    perTestId.set(result.testId, { add: [detection], removePredicate });
  }

  return { perTestId };
}

/**
 * Tolerates absolute vs relative URL, query strings, and trailing-slash normalisation.
 * Root '/' stays '/'.
 */
function pathsMatch(harPath: string, route: string): boolean {
  const normalize = (p: string): string => {
    try {
      const { pathname } = new URL(p, 'http://x');
      return pathname === '/' ? '/' : pathname.replace(/\/$/, '');
    } catch {
      return p === '/' ? '/' : p.replace(/\/$/, '');
    }
  };
  return normalize(harPath) === normalize(route);
}
