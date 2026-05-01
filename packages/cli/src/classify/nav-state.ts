// v0.22 nav-state classifier — per-transition invariant comparator (§3.6).
// Consumes (preState, interimState, postState, transition) and emits zero or
// one BugDetection per test.

import type { BugDetection, NavTransition, PreState, PostState, InterimState, ActionKind } from '../types.js';

export type NavClassifyInput = {
  pre: PreState;
  interim: InterimState;
  post: PostState;
  transition: NavTransition;
  /** seed action kind — recorded on nav_state_corruption for signature. */
  seedActionKind?: ActionKind;
  /** form collapse signature — used for nav_form_state_lost / nav_form_state_stale. */
  formSignature?: string;
  /** pageRoute string — matches tc.page. */
  pageRoute: string;
};

/**
 * Classify a nav-state test result into zero or one BugDetection.
 * Dispatches on transition.kind; each branch applies the invariant from §3.6.
 */
export function classifyNavTransition(input: NavClassifyInput): BugDetection[] {
  const { transition } = input;
  switch (transition.kind) {
    case 'refresh':
      return classifyRefresh(input);
    case 'back':
      return classifyBack(input);
    case 'forward':
      return [];
    case 'back_then_forward':
      return classifyBackThenForward(input);
    case 'deep_link_no_auth':
      return classifyDeepLinkNoAuth(input, transition);
    case 'history_corrupt':
      return classifyHistoryCorrupt(input, transition);
  }
}

// §3.6: refresh invariants
function classifyRefresh(input: NavClassifyInput): BugDetection[] {
  const { pre, interim, post, pageRoute, seedActionKind } = input;

  // Primary: double-mutation — mutation was in-flight, same request appears in post
  if (interim.mutationCompletionSignal === 'still-pending') {
    const doubled = findDoubledRequest(interim.inFlightRequests, post.networkRequests);
    if (doubled !== null) {
      return [buildDetection(
        'nav_refresh_double_mutation',
        `Refresh during pending ${doubled.method} ${doubled.path} caused double mutation`,
        pageRoute,
        { transitionKind: 'refresh', endpoint: `${doubled.method} ${doubled.path}` },
      )];
    }
  }

  // Secondary: state existed mid-flight, refresh erased it (no double-write evidence).
  // Only fire if all three signatures are populated (nav-state tests always populate them).
  if (
    post.domSignature !== undefined &&
    pre.domSignature !== undefined &&
    post.domSignature === pre.domSignature &&
    interim.domSignature !== pre.domSignature
  ) {
    return [buildDetection(
      'nav_state_corruption',
      `Refresh erased in-progress state: post-refresh DOM matches pre-action, not mid-action`,
      pageRoute,
      { transitionKind: 'refresh', mismatchKind: 'dom', seedActionKind },
    )];
  }

  return [];
}

// §3.6: back invariants
function classifyBack(input: NavClassifyInput): BugDetection[] {
  const { pre, interim, post, pageRoute, seedActionKind } = input;

  // Primary: back triggers re-submission of a mutating request
  const resubmitted = findWriteMethodRequest(interim.inFlightRequests, post.networkRequests);
  if (resubmitted !== null) {
    return [buildDetection(
      'nav_resubmit_on_back',
      `Back navigation triggered resubmit of ${resubmitted.method} ${resubmitted.path}`,
      pageRoute,
      { transitionKind: 'back', endpoint: `${resubmitted.method} ${resubmitted.path}` },
    )];
  }

  // Secondary: post is a third state (neither pre nor interim).
  // Only fire if all three signatures are populated.
  if (
    post.url === pre.url &&
    post.domSignature !== undefined &&
    pre.domSignature !== undefined &&
    post.domSignature !== interim.domSignature &&
    post.domSignature !== pre.domSignature
  ) {
    // Modal-close guard: if interim contained a modal-open DOM marker,
    // downgrade to secondary observation only (edge case §7.4).
    if (interim.domSignature.startsWith('modal:')) {
      return [];
    }
    return [buildDetection(
      'nav_state_corruption',
      `Back navigation produced a third DOM state (not pre, not interim)`,
      pageRoute,
      { transitionKind: 'back', mismatchKind: 'dom', seedActionKind },
    )];
  }

  return [];
}

// §3.6: back_then_forward — expected: same URL as interim → same DOM as interim
function classifyBackThenForward(input: NavClassifyInput): BugDetection[] {
  const { interim, post, pageRoute, seedActionKind } = input;

  if (
    post.url === interim.url &&
    post.domSignature !== undefined &&
    post.domSignature !== interim.domSignature
  ) {
    // Aria-live guard: if the only diff is inside an aria-live region, skip (§7.8).
    // The domSignature is computed over <main> content. If both are non-empty but
    // differ, we trust it as a real divergence unless the marker signals aria-live.
    if (post.domSignature.startsWith('arialive:') || interim.domSignature.startsWith('arialive:')) {
      return [];
    }
    return [buildDetection(
      'nav_state_corruption',
      `Forward after back: URL matches interim but DOM diverged (same URL, different state)`,
      pageRoute,
      { transitionKind: 'back_then_forward', mismatchKind: 'dom', seedActionKind },
    )];
  }

  return [];
}

// §3.6: deep_link_no_auth — expected: redirect to login or auth modal
function classifyDeepLinkNoAuth(
  input: NavClassifyInput,
  transition: Extract<NavTransition, { kind: 'deep_link_no_auth' }>,
): BugDetection[] {
  const { post, pageRoute } = input;

  // URL stayed on the protected route AND no auth modal selector found in post.
  // Only fire if domSignature is present (nav-state tests always populate it).
  if (
    post.url === transition.capturedUrl &&
    post.domSignature !== undefined &&
    post.domSignature !== '' &&
    !hasAuthModalMarker(post)
  ) {
    return [buildDetection(
      'nav_state_corruption',
      `Deep-link into auth-gated route rendered without authentication (URL: ${transition.capturedUrl})`,
      pageRoute,
      { transitionKind: 'deep_link_no_auth', mismatchKind: 'render-empty' },
    )];
  }

  return [];
}

// §3.6: history_corrupt — post.url should match last pushState's url
function classifyHistoryCorrupt(
  input: NavClassifyInput,
  transition: Extract<NavTransition, { kind: 'history_corrupt' }>,
): BugDetection[] {
  const { post, pageRoute, seedActionKind } = input;
  const lastPushState = transition.pushStates.at(-1);
  if (lastPushState === undefined) return [];

  if (lastPushState.url !== undefined && post.url !== lastPushState.url) {
    return [buildDetection(
      'nav_state_corruption',
      `history.pushState sequence: final URL (${post.url}) does not match last pushed URL (${lastPushState.url})`,
      pageRoute,
      { transitionKind: 'history_corrupt', mismatchKind: 'url', seedActionKind },
    )];
  }

  return [];
}

// Classify back-after-form-fill: called separately since it uses formSnapshot
export type BackAfterFormFillInput = {
  pre: PreState;
  interim: InterimState;
  post: PostState;
  pageRoute: string;
  formSignature?: string;
};

/**
 * Classify the back-after-form-fill transition (§3.6 / §5).
 * Returns zero or one detection.
 */
export function classifyBackAfterFormFill(input: BackAfterFormFillInput): BugDetection[] {
  const { pre, interim, post, pageRoute, formSignature } = input;

  // No formSnapshot = nothing was filled; no data to check
  if (interim.formSnapshot === undefined) return [];

  // Re-read form values from post state via navStateContext convention:
  // the executor captures a second formSnapshot in post.formSnapshot (stored in
  // postState via the navStateContext on the detection).
  // For the classifier, the post state must carry formSnapshot data too.
  // We use a convention: post.formSnapshot (added to PostState by the nav runner)
  // is checked here via the navState extension.
  const postFormSnapshot = (post as PostState & { formSnapshot?: Record<string, string> }).formSnapshot;

  if (pre.url === post.url) {
    if (postFormSnapshot === undefined || Object.keys(postFormSnapshot).length === 0) {
      // Fields gone entirely — lost state
      return [buildDetection(
        'nav_form_state_lost',
        `Back navigation lost filled form inputs on ${pageRoute}`,
        pageRoute,
        { transitionKind: 'back', formSignature },
      )];
    }

    // Check for stale derived state: fields present but at least one differs from what was filled
    const firstStaleName = findFirstStaleField(interim.formSnapshot, postFormSnapshot);
    if (firstStaleName !== null) {
      return [buildDetection(
        'nav_form_state_stale',
        `Back navigation preserved form values but derived state is stale (field: ${firstStaleName}) on ${pageRoute}`,
        pageRoute,
        { transitionKind: 'back', formSignature, staleField: firstStaleName },
      )];
    }
  }

  return [];
}

// ---- Helpers ----

type InFlight = { method: string; path: string; startedAtMs: number };
type PostRequest = { method: string; path: string };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function findDoubledRequest(
  inFlight: InFlight[],
  postRequests: PostRequest[],
): { method: string; path: string } | null {
  for (const inf of inFlight) {
    for (const post of postRequests) {
      if (inf.method === post.method && normalizePath(inf.path) === normalizePath(post.path)) {
        return { method: inf.method, path: inf.path };
      }
    }
  }
  return null;
}

function findWriteMethodRequest(
  inFlight: InFlight[],
  postRequests: PostRequest[],
): { method: string; path: string } | null {
  for (const inf of inFlight) {
    if (!WRITE_METHODS.has(inf.method)) continue;
    for (const post of postRequests) {
      if (inf.method === post.method && normalizePath(inf.path) === normalizePath(post.path)) {
        return { method: inf.method, path: inf.path };
      }
    }
  }
  return null;
}

function hasAuthModalMarker(post: PostState): boolean {
  const sig = post.domSignature ?? '';
  return sig.startsWith('auth:') || sig.includes('login') || sig.includes('sign-in');
}

function findFirstStaleField(
  filled: Record<string, string>,
  current: Record<string, string>,
): string | null {
  for (const [name, expected] of Object.entries(filled)) {
    const actual = current[name];
    if (actual !== expected) return name;
  }
  return null;
}

/** Strip dynamic path segments (UUIDs, numeric IDs) for grouping. */
function normalizePath(p: string): string {
  return p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/<id>')
    .replace(/\/\d+/g, '/<n>');
}

function buildDetection(
  kind: BugDetection['kind'],
  rootCause: string,
  pageRoute: string,
  navCtx: NonNullable<BugDetection['navStateContext']>,
): BugDetection {
  return {
    kind,
    rootCause,
    pageRoute,
    navStateContext: navCtx,
  };
}
