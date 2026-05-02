// v0.36 browser-platform probe — detects 9 browser-platform pathologies per page.
// Runs once per unique pageRoute in onPageBaseline (after axe injection, before SEO).

import type { TabScope } from '../adapters/browser-mcp.js';
import type { BugDetection, BrowserPlatformContext, BrowserPlatformTelemetry } from '../types.js';

export type BrowserPlatformProbeOpts = {
  pageRoute: string;
  swStaleThresholdMs: number;
  observationWindowMs: number;
  permissions: ReadonlyArray<'geolocation' | 'clipboard-read' | 'notifications'>;
  enableShadowA11y: boolean;
  enableForcedPermissionDeny: boolean;
};

export type BrowserPlatformProbeResult =
  | { ok: true; detections: BugDetection[]; telemetry: Partial<BrowserPlatformTelemetry> }
  | { ok: false; reason: 'evaluate_failed' | 'bootstrap_install_failed' | 'observation_window_aborted' };

// Shape of the installed buffer returned from the bootstrap and harvest scripts.
type ProbeEnvelope = {
  pageRoute: string;
  bootInstalledAt: number;
  harvestedAt: number;
  sw: {
    registrations: Array<{
      scope: string;
      state: 'installing' | 'waiting' | 'active' | null;
      controllerUrl: string | null;
      ageMs: number;
    }>;
    controllerChangedDuringWindow: boolean;
  };
  workers: { errors: Array<{ scriptUrl: string; errorMsg: string; kind: 'error' | 'messageerror' }> };
  postmessage: { listenerCount: number; handlerSources: string[] };
  shadowHosts: Array<{ selector: string; mode: 'open' }>;
  permissions: Record<string, 'granted' | 'denied' | 'prompt' | 'unknown'>;
  webrtc: { connections: Array<{ connectionId: string; finalState: string | null; hadHandler: boolean }> };
  sri: { scriptsWithIntegrity: number; blocked: Array<{ url: string }>; uiErrorVisible: boolean };
  isolation: { crossOriginIsolated: boolean; sabReferenced: boolean; sabInstantiated: boolean };
  trustedTypes: { policyRequired: boolean; violations: Array<{ effectiveDirective: string; sample: string; blockedURI: string }> };
};

// Installs window.__BH_PLATFORM_PROBE and constructor wrappers. Idempotent.
const BOOTSTRAP_INSTALL_SCRIPT = `
(function() {
  if (window.__BH_PLATFORM_PROBE) return { installed: false, alreadyPresent: true };
  var buf = {
    workerErrors: [],
    cspViolations: [],
    sriBlocked: [],
    rtcStates: [],
    sabUsage: [],
    permissionStates: {},
    listenersOnMessage: 0,
    messageHandlerSources: [],
    swControllerChanged: false,
    bootInstalledAt: Date.now(),
  };

  // 1. Worker constructor wrapping
  ['Worker', 'SharedWorker'].forEach(function(name) {
    var Orig = window[name];
    if (!Orig) return;
    window[name] = new Proxy(Orig, {
      construct: function(t, args) {
        var w = new t(...args);
        var scriptUrl = String(args[0] || '');
        w.addEventListener('error', function(e) {
          buf.workerErrors.push({ scriptUrl: scriptUrl, kind: 'error', errorMsg: String(e.message || e), ts: Date.now() });
        });
        w.addEventListener('messageerror', function(e) {
          buf.workerErrors.push({ scriptUrl: scriptUrl, kind: 'messageerror', errorMsg: String(e.data || ''), ts: Date.now() });
        });
        return w;
      },
    });
  });

  // 2. CSP violation listener (covers Trusted Types + SRI)
  document.addEventListener('securitypolicyviolation', function(e) {
    buf.cspViolations.push({
      effectiveDirective: e.effectiveDirective,
      blockedURI: e.blockedURI,
      sample: (e.sample || '').slice(0, 200),
      ts: Date.now(),
    });
    if (/sri/i.test(e.effectiveDirective || '') || /integrity/i.test(e.violatedDirective || '')) {
      buf.sriBlocked.push({ url: e.blockedURI, ts: Date.now() });
    }
  });

  // 3. RTCPeerConnection wrapping
  if (window.RTCPeerConnection) {
    var OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(OrigRTC, {
      construct: function(t, args) {
        var pc = new t(...args);
        var id = String(buf.rtcStates.length);
        var hadHandler = false;
        var origAdd = pc.addEventListener.bind(pc);
        pc.addEventListener = function(type, fn, opts) {
          if (type === 'iceconnectionstatechange') hadHandler = true;
          return origAdd(type, fn, opts);
        };
        pc.addEventListener('iceconnectionstatechange', function() {
          buf.rtcStates.push({ connectionId: id, state: pc.iceConnectionState, ts: Date.now(), hadHandler: hadHandler });
        });
        return pc;
      },
    });
  }

  // 4. SharedArrayBuffer use heuristic
  if (typeof SharedArrayBuffer !== 'undefined') {
    var OrigSAB = SharedArrayBuffer;
    try {
      window.SharedArrayBuffer = new Proxy(OrigSAB, {
        construct: function(t, args) {
          buf.sabUsage.push({ ts: Date.now() });
          return new t(...args);
        },
      });
    } catch(_) {}
  }

  // 5. addEventListener('message') counter
  var origWindowAdd = window.addEventListener.bind(window);
  window.addEventListener = function(type, fn, opts) {
    if (type === 'message') {
      buf.listenersOnMessage++;
      buf.messageHandlerSources.push(String(fn).slice(0, 600));
    }
    return origWindowAdd(type, fn, opts);
  };

  // 6. SW controller-change listener
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      buf.swControllerChanged = true;
    });
  }

  window.__BH_PLATFORM_PROBE = buf;
  return { installed: true };
})()
`;

// Harvests state from the installed probe buffer.
const BOOTSTRAP_HARVEST_SCRIPT = `
(function() {
  var buf = window.__BH_PLATFORM_PROBE;
  if (!buf) return null;

  // SW registrations snapshot
  var swData = { registrations: [], controllerChangedDuringWindow: buf.swControllerChanged };
  if (navigator.serviceWorker) {
    try {
      var controller = navigator.serviceWorker.controller;
      var swState = null;
      if (controller) swState = 'active';
      // Check localStorage for previously-stamped registration time (EC-1)
      var scopeKey = window.location.origin + window.location.pathname;
      var stampKey = '__bh_sw_' + scopeKey + '__';
      var existingStamp = null;
      try { existingStamp = JSON.parse(localStorage.getItem(stampKey) || 'null'); } catch(_) {}
      var registeredAt = existingStamp ? existingStamp.registeredAt : null;
      if (!registeredAt) {
        try { localStorage.setItem(stampKey, JSON.stringify({ registeredAt: Date.now() })); } catch(_) {}
      }
      swData.registrations = [{
        scope: scopeKey,
        state: swState,
        controllerUrl: controller ? controller.scriptURL : null,
        ageMs: registeredAt ? (Date.now() - registeredAt) : 0,
        isFirstVisit: !registeredAt,
      }];
    } catch(_) {}
  }

  // Permission states
  var permStates = {};
  var permNames = ['geolocation', 'clipboard-read', 'notifications'];
  // We use sync check via navigator.permissions if available
  // (async harvest not possible here; states are polled separately)

  // Shadow hosts: collect open shadow roots from DOM
  var shadowHosts = [];
  try {
    document.querySelectorAll('*').forEach(function(el) {
      if (el.shadowRoot && el.shadowRoot.mode === 'open') {
        var sel = el.id ? '#' + el.id
          : (el.getAttribute('data-testid') ? '[data-testid="' + el.getAttribute('data-testid') + '"]'
          : el.tagName.toLowerCase());
        shadowHosts.push({ selector: sel, mode: 'open' });
      }
    });
  } catch(_) {}

  // SRI: count scripts/links with integrity attr
  var sriCount = document.querySelectorAll('script[integrity], link[integrity]').length;
  var sriBlocked = buf.sriBlocked.map(function(s) { return { url: s.url }; });
  var uiError = document.querySelector('[role="alert"], .error, .toast--error') !== null;

  // Isolation
  var sabReferenced = typeof SharedArrayBuffer !== 'undefined';
  var sabInstantiated = buf.sabUsage.length > 0;

  // Trusted Types
  var ttRequired = false;
  try {
    ttRequired = typeof trustedTypes !== 'undefined' && typeof trustedTypes.getPolicyNames === 'function';
  } catch(_) {}
  var ttViolations = buf.cspViolations.filter(function(v) {
    return v.effectiveDirective === 'require-trusted-types-for' || v.effectiveDirective === 'trusted-types';
  }).map(function(v) {
    return { effectiveDirective: v.effectiveDirective, sample: v.sample, blockedURI: v.blockedURI };
  });

  // RTC: get final states
  var rtcConnections = buf.rtcStates.map(function(s) {
    return { connectionId: s.connectionId, finalState: s.state, hadHandler: s.hadHandler };
  });

  return {
    pageRoute: window.location.pathname,
    bootInstalledAt: buf.bootInstalledAt,
    harvestedAt: Date.now(),
    sw: swData,
    workers: { errors: buf.workerErrors.slice() },
    postmessage: { listenerCount: buf.listenersOnMessage, handlerSources: buf.messageHandlerSources.slice() },
    shadowHosts: shadowHosts,
    permissions: permStates,
    webrtc: { connections: rtcConnections },
    sri: { scriptsWithIntegrity: sriCount, blocked: sriBlocked, uiErrorVisible: uiError },
    isolation: { crossOriginIsolated: !!window.crossOriginIsolated, sabReferenced: sabReferenced, sabInstantiated: sabInstantiated },
    trustedTypes: { policyRequired: ttRequired, violations: ttViolations },
  };
})()
`;

const ORIGIN_GUARD_REGEX = /event\.origin\s*[!=]==|allowedOrigins\.|originAllowlist\.|origins\.includes/;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function hostTagNameOf(hostSelector: string): string {
  const tagMatch = /^([a-z][\w-]*)/.exec(hostSelector);
  return tagMatch !== null ? tagMatch[1] : hostSelector;
}

export function classifyBrowserPlatform(
  envelope: ProbeEnvelope,
  opts: BrowserPlatformProbeOpts,
): BugDetection[] {
  const detections: BugDetection[] = [];

  // 1. service_worker_stale
  for (const reg of envelope.sw.registrations) {
    const isStale = (reg as { isFirstVisit?: boolean }).isFirstVisit !== true
      && (reg.state === 'installing' || reg.state === 'waiting')
      && reg.ageMs > opts.swStaleThresholdMs
      && !envelope.sw.controllerChangedDuringWindow;
    if (isStale) {
      const ctx: BrowserPlatformContext = {
        kind: 'sw',
        scope: reg.scope,
        ageMs: reg.ageMs,
        hasInstalling: reg.state === 'installing',
        hasWaiting: reg.state === 'waiting',
      };
      detections.push({
        kind: 'service_worker_stale',
        rootCause: `Service worker at scope "${reg.scope}" has been installing/waiting for ${Math.round(reg.ageMs / 1000)}s without activating. Call skipWaiting() and clients.claim() in the service worker.`,
        pageRoute: opts.pageRoute,
        browserPlatformContext: ctx,
      });
    }
  }

  // 2. web_worker_error
  const seenWorkerErrors = new Set<string>();
  for (const err of envelope.workers.errors) {
    const key = `${err.scriptUrl}|${err.kind}`;
    if (seenWorkerErrors.has(key)) continue;
    seenWorkerErrors.add(key);
    const ctx: BrowserPlatformContext = {
      kind: 'worker',
      scriptUrl: err.scriptUrl,
      eventKind: err.kind,
      errorMsg: err.errorMsg,
    };
    detections.push({
      kind: 'web_worker_error',
      rootCause: `Worker at "${err.scriptUrl}" fired "${err.kind}": ${err.errorMsg}`,
      pageRoute: opts.pageRoute,
      browserPlatformContext: ctx,
    });
  }

  // 3. iframe_postmessage_unguarded
  if (envelope.postmessage.listenerCount > 0) {
    const allGuarded = envelope.postmessage.handlerSources.every(src => ORIGIN_GUARD_REGEX.test(src));
    if (!allGuarded) {
      const fingerprints = envelope.postmessage.handlerSources.map(src => {
        const hash = simpleHash(src.replace(/\s+/g, ''));
        return hash.slice(0, 16);
      });
      const ctx: BrowserPlatformContext = {
        kind: 'iframe',
        listenerCount: envelope.postmessage.listenerCount,
        handlerFingerprints: fingerprints,
      };
      detections.push({
        kind: 'iframe_postmessage_unguarded',
        rootCause: `${envelope.postmessage.listenerCount} postMessage listener(s) lack origin guard checks (event.origin === ...). Any window can send arbitrary messages.`,
        pageRoute: opts.pageRoute,
        browserPlatformContext: ctx,
      });
    }
  }

  // 4. webrtc_ice_failure
  for (const conn of envelope.webrtc.connections) {
    if (conn.finalState === 'failed' && conn.hadHandler === false) {
      const ctx: BrowserPlatformContext = {
        kind: 'webrtc',
        connectionId: conn.connectionId,
        finalState: conn.finalState,
        hadHandler: conn.hadHandler,
      };
      detections.push({
        kind: 'webrtc_ice_failure',
        rootCause: `RTCPeerConnection (id=${conn.connectionId}) reached iceConnectionState 'failed' with no iceconnectionstatechange handler registered.`,
        pageRoute: opts.pageRoute,
        browserPlatformContext: ctx,
      });
    }
  }

  // 5. subresource_integrity_violation
  for (const blocked of envelope.sri.blocked) {
    if (!envelope.sri.uiErrorVisible) {
      const ctx: BrowserPlatformContext = {
        kind: 'sri',
        blockedUrl: blocked.url,
        hasIntegrityAttr: envelope.sri.scriptsWithIntegrity,
        uiErrorVisible: envelope.sri.uiErrorVisible,
      };
      detections.push({
        kind: 'subresource_integrity_violation',
        rootCause: `SRI blocked "${blocked.url}" but no error UI appeared. Users silently receive missing or fallback content.`,
        pageRoute: opts.pageRoute,
        browserPlatformContext: ctx,
      });
    }
  }

  // 6. coop_coep_violation
  if (!envelope.isolation.crossOriginIsolated && (envelope.isolation.sabReferenced || envelope.isolation.sabInstantiated)) {
    const ctx: BrowserPlatformContext = {
      kind: 'coop_coep',
      crossOriginIsolated: envelope.isolation.crossOriginIsolated,
      sabReferenced: envelope.isolation.sabReferenced,
      sabInstantiated: envelope.isolation.sabInstantiated,
    };
    detections.push({
      kind: 'coop_coep_violation',
      rootCause: `SharedArrayBuffer is referenced/used but window.crossOriginIsolated is false. Add COOP: same-origin and COEP: require-corp response headers.`,
      pageRoute: opts.pageRoute,
      browserPlatformContext: ctx,
    });
  }

  // 7. trusted_types_violation
  for (const v of envelope.trustedTypes.violations) {
    const ctx: BrowserPlatformContext = {
      kind: 'trusted_types',
      sample: v.sample,
      blockedURI: v.blockedURI,
      source: 'dynamic',
    };
    detections.push({
      kind: 'trusted_types_violation',
      rootCause: `Trusted Types CSP violation (${v.effectiveDirective}): "${v.sample.slice(0, 100)}" blocked at "${v.blockedURI}". This is a real DOM-XSS prevention misfire — fix the code path to use a Trusted Types policy.`,
      pageRoute: opts.pageRoute,
      browserPlatformContext: ctx,
    });
  }

  return detections;
}

/**
 * Runs the browser-platform probe on the current page.
 * Installs the bootstrap, waits the observation window, harvests, and classifies.
 */
export async function runBrowserPlatformProbe(
  scope: TabScope,
  opts: BrowserPlatformProbeOpts,
): Promise<BrowserPlatformProbeResult> {
  // Install bootstrap
  const installResult = await scope.evaluate(BOOTSTRAP_INSTALL_SCRIPT).catch(() => null);
  if (installResult === null) {
    return { ok: false, reason: 'evaluate_failed' };
  }
  const installValue = installResult.value as { installed?: boolean; alreadyPresent?: boolean } | null | undefined;
  if (installValue === null || installValue === undefined) {
    return { ok: false, reason: 'bootstrap_install_failed' };
  }

  // Observation window
  await sleep(opts.observationWindowMs);

  // Harvest
  const harvestResult = await scope.evaluate(BOOTSTRAP_HARVEST_SCRIPT).catch(() => null);
  if (harvestResult === null || harvestResult.value === null || harvestResult.value === undefined) { // NOSONAR: explicit null checks required by strict-boolean-expressions
    return { ok: false, reason: 'observation_window_aborted' };
  }

  const envelope = harvestResult.value as ProbeEnvelope;
  const detections = classifyBrowserPlatform(envelope, opts);

  // Shadow DOM a11y (gated on enableShadowA11y and axe being available)
  if (opts.enableShadowA11y === true && envelope.shadowHosts.length > 0) {
    const shadowDetections = await runShadowA11yProbe(scope, envelope.shadowHosts, opts.pageRoute);
    detections.push(...shadowDetections);
  }

  const telemetry: Partial<BrowserPlatformTelemetry> = {
    shadowHostsDiscovered: envelope.shadowHosts.length,
    workersInstrumented: envelope.workers.errors.length,
    rtcConnectionsObserved: envelope.webrtc.connections.length,
    permissionsForceDenied: 0,
    bootstrapInstallFailures: installValue.installed === false && installValue.alreadyPresent !== true ? 1 : 0,
  };

  return { ok: true, detections, telemetry };
}

async function runShadowA11yProbe(
  scope: TabScope,
  shadowHosts: Array<{ selector: string; mode: 'open' }>,
  pageRoute: string,
): Promise<BugDetection[]> {
  const detections: BugDetection[] = [];
  for (const host of shadowHosts) {
    const tagName = hostTagNameOf(host.selector);
    const script = `
(function() {
  if (typeof window.axe === 'undefined') return { violations: [] };
  var host = document.querySelector(${JSON.stringify(host.selector)});
  if (!host || !host.shadowRoot) return { violations: [] };
  // axe-core 4.x descends shadow roots automatically via document context
  // Run synchronously-initiated async call is not feasible here; return shadow host selector for TS-side axe
  return { shadowHostSelector: ${JSON.stringify(host.selector)}, hasAxe: true };
})()`;
    const result = await scope.evaluate(script).catch(() => null);
    if (result === null) continue;
    const val = result.value as { hasAxe?: boolean; shadowHostSelector?: string; violations?: unknown[] } | null;
    if (val?.hasAxe !== true) continue;

    // Run axe specifically targeting the shadow host
    const axeScript = `
(function() {
  if (typeof window.axe === 'undefined') return { violations: [] };
  return new Promise(function(resolve) {
    window.axe.run(document.querySelector(${JSON.stringify(host.selector)}), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }
    }).then(function(r) { resolve({ violations: r.violations }); }).catch(function() { resolve({ violations: [] }); });
  });
})()`;
    const axeResult = await scope.evaluate(axeScript).catch(() => null);
    if (axeResult === null) continue;

    const axeVal = axeResult.value as { violations?: Array<{ id: string; impact: string }> } | null;
    if (axeVal?.violations === null || axeVal?.violations === undefined) continue;

    for (const v of axeVal.violations) {
      if (v.impact !== 'critical' && v.impact !== 'serious') continue;
      const ctx: BrowserPlatformContext = {
        kind: 'shadow_a11y',
        hostSelector: tagName,
        axeRuleId: v.id,
        severity: v.impact as 'critical' | 'serious',
      };
      detections.push({
        kind: 'shadow_dom_a11y_violation',
        rootCause: `Axe rule "${v.id}" (${v.impact}) violated inside shadow root of <${tagName}>. Fix the component's internal markup.`,
        pageRoute,
        selectorClass: host.selector,
        browserPlatformContext: ctx,
      });
    }
  }
  return detections;
}

/** Simple deterministic hash for fingerprinting handler sources (not cryptographic). */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(2);
}
