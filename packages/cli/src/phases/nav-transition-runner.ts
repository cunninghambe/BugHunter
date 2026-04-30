// v0.22 nav-transition-runner — per-transition executor drivers (§3.2 / §3.5).
//
// Each exported helper drives one NavTransition kind via camofox evaluate/navigate
// primitives. All transitions use existing camofox evaluate() calls; no new MCP
// tools are required (§3.2).
//
// Settle convention: 250ms delay after each browser history mutation (history.back/
// forward). The existing 30s asyncMaxWaitMs ceiling is the outer timeout managed
// by the caller (execute.ts). Short-settle for nav tests = 5s cap on seed action.

import type { TabScope } from '../adapters/browser-mcp.js';
import type { NavTransition, InterimState, Action, ActionKind } from '../types.js';
import { log } from '../log.js';
import { classifyNavTransition, classifyBackAfterFormFill } from '../classify/nav-state.js';
import type { BugDetection, PreState, PostState } from '../types.js';
import { createHash } from 'node:crypto';

// ---- Capture helpers ----

/** Capture current URL from the live tab. */
async function captureUrl(scope: TabScope): Promise<string> {
  const result = await scope.evaluate('window.location.href');
  return typeof result.value === 'string' ? result.value : '';
}

/**
 * Compute a SHA-1 over the visible text of the <main> element (or body as fallback).
 * Used for domSignature in InterimState and post-state comparison.
 * The hash is truncated to 20 hex chars for readability.
 */
async function captureDomSignature(scope: TabScope): Promise<string> {
  const result = await scope.evaluate(
    `(function(){var el=document.querySelector('[role="main"],main');var text=(el||document.body||{}).textContent||'';return text.trim().slice(0,4000);})()`,
  );
  const text = typeof result.value === 'string' ? result.value : '';
  return createHash('sha1').update(text).digest('hex').slice(0, 20);
}

/**
 * Capture form field values for back-after-form-fill seed.
 * Open question Q1: only supports <input> and <textarea> (rich-text deferred to v0.23).
 */
async function captureFormSnapshot(scope: TabScope, formSelector: string): Promise<Record<string, string>> {
  const result = await scope.evaluate(
    `(function(){var f=document.querySelector(${JSON.stringify(formSelector)});if(!f)return{};var out={};f.querySelectorAll('input[name],textarea[name]').forEach(function(el){out[el.name]=el.value||'';});return out;})()`,
  );
  const raw = result.value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, string>;
}

/**
 * Capture interimState (§3.3). Called after seed action settles, before transition.
 */
export async function captureInterimState(
  scope: TabScope,
  seedAction: Action | undefined,
): Promise<InterimState> {
  const url = await captureUrl(scope).catch(() => '');
  const domSignature = await captureDomSignature(scope).catch(() => '');

  // Form snapshot: only when seed was a submit or fill
  let formSnapshot: Record<string, string> | undefined;
  if (
    seedAction !== undefined &&
    (seedAction.kind === 'submit' || seedAction.kind === 'fill') &&
    seedAction.selector !== undefined
  ) {
    formSnapshot = await captureFormSnapshot(scope, seedAction.selector).catch(() => undefined);
  }

  // inFlightRequests: we don't have direct CDP network access in camofox v0.1;
  // use an empty list. The mutation completion signal is derived from post-seed DOM.
  // Full network capture is deferred to camofox v0.2 (HAR stub per §3.7).
  return {
    url,
    domSignature,
    inFlightRequests: [],
    formSnapshot,
    // Conservative: assume the seed completed (response-200ish) since we settled first.
    // refresh-mid-mutation skips settle (§3.5), so this will be 'still-pending' only
    // when the caller explicitly passes 'still-pending' (handled in runRefreshMidMutation).
    mutationCompletionSignal: 'response-200ish',
  };
}

/** 250ms settle helper (existing convention from v0.9). */
function settle250(): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, 250); });
}

// ---- Per-transition drivers ----

/** refresh: fire location.reload() then wait for DOM quiet. */
export async function runRefreshTransition(scope: TabScope): Promise<void> {
  await scope.evaluate('location.reload()');
  await settle250();
  // Additional snapshot-quiet wait: take a snapshot to confirm page has re-rendered.
  await scope.snapshot().catch(() => null);
}

/**
 * refresh-mid-mutation: called BEFORE the seed settles.
 * Returns an interim state with mutationCompletionSignal = 'still-pending'.
 */
export async function runRefreshMidMutation(
  scope: TabScope,
  seedAction: Action | undefined,
): Promise<InterimState> {
  // Capture state immediately after seed dispatch (before settle)
  const url = await captureUrl(scope).catch(() => '');
  const domSignature = await captureDomSignature(scope).catch(() => '');
  let formSnapshot: Record<string, string> | undefined;
  if (seedAction?.kind === 'submit' && seedAction.selector !== undefined) {
    formSnapshot = await captureFormSnapshot(scope, seedAction.selector).catch(() => undefined);
  }

  // Q2 open question: no configurable race window — fire reload immediately.
  // On fast servers the mutation may complete before reload; that's a false-negative
  // (acceptable per spec). On slow servers the race fires correctly.
  await scope.evaluate('location.reload()');
  await settle250();

  return {
    url,
    domSignature,
    inFlightRequests: [],
    formSnapshot,
    mutationCompletionSignal: 'still-pending',
  };
}

/** back: history.back() then settle. */
export async function runBackTransition(scope: TabScope): Promise<void> {
  await scope.evaluate('history.back()');
  await settle250();
  await scope.snapshot().catch(() => null);
}

/** forward: history.forward() then settle. */
export async function runForwardTransition(scope: TabScope): Promise<void> {
  await scope.evaluate('history.forward()');
  await settle250();
  await scope.snapshot().catch(() => null);
}

/** back_then_forward: back → settle → forward → settle (depth 2). */
export async function runBackThenForwardTransition(scope: TabScope): Promise<void> {
  await scope.evaluate('history.back()');
  await settle250();
  await scope.snapshot().catch(() => null);
  await scope.evaluate('history.forward()');
  await settle250();
  await scope.snapshot().catch(() => null);
}

/**
 * deep_link_no_auth: navigate to capturedUrl without authentication.
 * Per §3.2: logout via existing v0.7 auth helper if available, else
 * simply navigate (anonymous context already established by the planner).
 * Q3 conservative choice: use lazy URL = appBaseUrl + route rather than
 * a captured post-auth URL. This avoids an extra capture phase.
 */
export async function runDeepLinkNoAuth(
  scope: TabScope,
  capturedUrl: string,
): Promise<void> {
  await scope.navigate(capturedUrl);
  await settle250();
  await scope.snapshot().catch(() => null);
}

/**
 * history_corrupt: sequence of history.pushState calls, then settle.
 * Per §3.2 and edge case §7.7: no await between pushStates.
 */
export async function runHistoryCorruptTransition(
  scope: TabScope,
  pushStates: Array<{ state: unknown; url?: string }>,
): Promise<void> {
  for (const ps of pushStates) {
    const stateJson = JSON.stringify(ps.state ?? {});
    const urlArg = ps.url !== undefined ? JSON.stringify(ps.url) : 'window.location.href';
    await scope.evaluate(`history.pushState(${stateJson}, '', ${urlArg})`).catch(err => {
      log.debug('history_corrupt: pushState failed', { err: String(err) });
    });
  }
  await settle250();
  await scope.snapshot().catch(() => null);
}

// ---- Dispatcher ----

/**
 * Main dispatcher: classifies the transition against all three states and returns bug detections.
 * Called from executeUiTestInner after the seed action and interimState capture.
 */
export function runNavTransition(
  _scope: TabScope,
  transition: NavTransition,
  pre: PreState,
  interim: InterimState,
  post: PostState,
  seedAction: Action | undefined,
  pageRoute: string,
): BugDetection[] {
  const seedActionKind: ActionKind | undefined = seedAction?.kind;
  return classifyNavTransition({ pre, interim, post, transition, seedActionKind, pageRoute });
}

/**
 * Post-transition form snapshot classification.
 * Called after runNavTransition for back-after-form-fill seeds.
 */
export async function capturePostFormAndClassify(
  scope: TabScope,
  pre: PreState,
  interim: InterimState,
  post: PostState,
  seedAction: Action | undefined,
  pageRoute: string,
  formSignature: string | undefined,
): Promise<BugDetection[]> {
  if (seedAction?.kind !== 'submit' || seedAction.selector === undefined || seedAction.fillOnly !== true) {
    return [];
  }

  const postForm = await captureFormSnapshot(scope, seedAction.selector).catch(() => ({}));
  const postWithForm = { ...post, formSnapshot: postForm } as never;

  return classifyBackAfterFormFill({
    pre,
    interim,
    post: postWithForm,
    pageRoute,
    formSignature,
  });
}
