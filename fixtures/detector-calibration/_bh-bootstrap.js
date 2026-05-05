// Shared V56.4 browser-harness bootstrap.
// Required-import on every browser-harness fixture's server.js: each fixture
// reads this file at module load and inlines the contents into a <script> tag
// in the head of every HTML route.
//
// Why DOM-bridged: camofox's evaluate runs in an isolated world; `window.__bh`
// set by the page's main-world scripts is invisible there. The bootstrap
// mirrors observation state into the textContent of a hidden
// <script type="application/json" id="__bh-data"> element which the harness's
// HARVEST_SCRIPT (in packages/cli/src/harness/browser-executor.ts) reads via
// document.getElementById — DOM is shared across all worlds.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BOOTSTRAP_SOURCE = `(() => {
  if (window.__bh && window.__bh.installed) return;
  const dataEl = document.createElement('script');
  dataEl.type = 'application/json';
  dataEl.id = '__bh-data';
  dataEl.textContent = '{}';
  (document.head || document.documentElement).appendChild(dataEl);
  const bh = {
    installed: true,
    consoleEvents: [],
    uncaughtErrors: [],
    unhandledRejections: [],
    performanceEntries: [],
    resourceRequests: [],
    axeViolations: [],
    harvestWarnings: [],
    sync: function() {
      try {
        dataEl.textContent = JSON.stringify({
          installed: bh.installed,
          consoleEvents: bh.consoleEvents.slice(-200),
          uncaughtErrors: bh.uncaughtErrors.slice(-50),
          unhandledRejections: bh.unhandledRejections.slice(-50),
          performanceEntries: bh.performanceEntries.slice(-200),
          resourceRequests: bh.resourceRequests.slice(-200),
          axeViolations: bh.axeViolations.slice(-100),
          navInputs: (bh.navInputs || []).slice(-20),
          backAfterFormFill: bh.backAfterFormFill || null,
          keyboardTrap: bh.keyboardTrap || null,
          focusAfterAction: bh.focusAfterAction || null,
          shadowAxeViolations: (bh.shadowAxeViolations || []).slice(-100),
          visibilityChangeStateLoss: bh.visibilityChangeStateLoss || null,
          missingStateChangeInput: bh.missingStateChangeInput || null,
          surfaceCallResults: (bh.surfaceCallResults || []).slice(-50),
          idorReplays: (bh.idorReplays || []).slice(-30),
          racePlans: (bh.racePlans || []).slice(-30),
          multiContextDivergence: bh.multiContextDivergence || null,
          networkFaultUnhandledInput: bh.networkFaultUnhandledInput || null,
          optimisticNoRevertInput: bh.optimisticNoRevertInput || null,
          browserPlatformDetections: (bh.browserPlatformDetections || []).slice(-30),
          visualAnomalies: (bh.visualAnomalies || []).slice(-30),
          promptInjectionProbes: (bh.promptInjectionProbes || []).slice(-30),
          rtlGeoFindings: (bh.rtlGeoFindings || []).slice(-30),
          sentinelEvents: (bh.sentinelEvents || []).slice(-50),
          harvestWarnings: bh.harvestWarnings.slice(-50),
        });
      } catch (_e) { bh.harvestWarnings.push('sync_threw:' + String(_e)); }
    },
    pushAxe: function(violation) { bh.axeViolations.push(violation); bh.sync(); },
    pushPerf: function(entry) { bh.performanceEntries.push(entry); bh.sync(); },
    pushResource: function(req) { bh.resourceRequests.push(req); bh.sync(); },
    // V56.4.9: nav-state inputs. Each call adds one transition the harness will
    // dispatch through production classifyNavTransition().
    pushNavInput: function(input) { bh.navInputs = bh.navInputs || []; bh.navInputs.push(input); bh.sync(); },
    setBackAfterFormFill: function(input) { bh.backAfterFormFill = input; bh.sync(); },
    // V56.4.10 (Bucket E): a11y-baseline inputs.
    setKeyboardTrap: function(result) { bh.keyboardTrap = result; bh.sync(); },
    setFocusAfterAction: function(result) { bh.focusAfterAction = result; bh.sync(); },
    pushShadowAxe: function(violation) { bh.shadowAxeViolations = bh.shadowAxeViolations || []; bh.shadowAxeViolations.push(violation); bh.sync(); },
    setVisibilityChangeStateLoss: function(payload) { bh.visibilityChangeStateLoss = payload; bh.sync(); },
    // V56.4.11 (Bucket B remainder).
    setMissingStateChangeInput: function(input) { bh.missingStateChangeInput = input; bh.sync(); },
    pushSurfaceCallResult: function(result) { bh.surfaceCallResults = bh.surfaceCallResults || []; bh.surfaceCallResults.push(result); bh.sync(); },
    // V56.4.13 (Bucket F): cross-role / race / multi-context shapes.
    pushIdorReplay: function(replay) { bh.idorReplays = bh.idorReplays || []; bh.idorReplays.push(replay); bh.sync(); },
    pushRacePlan: function(plan) { bh.racePlans = bh.racePlans || []; bh.racePlans.push(plan); bh.sync(); },
    setMultiContextDivergence: function(payload) { bh.multiContextDivergence = payload; bh.sync(); },
    // V56.4.14 (Bucket G): final 8 BugKinds.
    setNetworkFaultUnhandledInput: function(input) { bh.networkFaultUnhandledInput = input; bh.sync(); },
    setOptimisticNoRevertInput: function(input) { bh.optimisticNoRevertInput = input; bh.sync(); },
    pushBrowserPlatformDetection: function(d) { bh.browserPlatformDetections = bh.browserPlatformDetections || []; bh.browserPlatformDetections.push(d); bh.sync(); },
    pushVisualAnomaly: function(anomaly) { bh.visualAnomalies = bh.visualAnomalies || []; bh.visualAnomalies.push(anomaly); bh.sync(); },
    pushPromptInjectionProbe: function(input) { bh.promptInjectionProbes = bh.promptInjectionProbes || []; bh.promptInjectionProbes.push(input); bh.sync(); },
    pushRtlGeoFinding: function(finding) { bh.rtlGeoFindings = bh.rtlGeoFindings || []; bh.rtlGeoFindings.push(finding); bh.sync(); },
    // V56.4.15: generic sentinel events for deferred-kind wiring.
    pushSentinelEvent: function(ev) { bh.sentinelEvents = bh.sentinelEvents || []; bh.sentinelEvents.push(ev); bh.sync(); },
  };
  window.__bh = bh;
  bh.sync();
  ['log','info','warn','error'].forEach(level => {
    const orig = console[level];
    console[level] = function() {
      try {
        const args = Array.prototype.slice.call(arguments);
        const msg = args.map(a => {
          if (a === null || a === undefined) return String(a);
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_e) { return String(a); }
        }).join(' ');
        bh.consoleEvents.push({ level: level, message: msg.slice(0, 2000) });
        bh.sync();
      } catch (_e) {
        bh.harvestWarnings.push('console_capture_threw:' + String(_e));
        bh.sync();
      }
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', (ev) => {
    try {
      bh.uncaughtErrors.push({
        message: String(ev.message || '').slice(0, 1000),
        filename: ev.filename, lineno: ev.lineno, colno: ev.colno,
        stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4000) : undefined,
      });
      bh.sync();
    } catch (_e) { bh.harvestWarnings.push('error_capture_threw:' + String(_e)); bh.sync(); }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const r = ev.reason;
      const reasonStr = r instanceof Error ? r.message : (typeof r === 'string' ? r : JSON.stringify(r));
      bh.unhandledRejections.push({
        reason: String(reasonStr || 'unknown').slice(0, 1000),
        stack: r && r.stack ? String(r.stack).slice(0, 4000) : undefined,
      });
      bh.sync();
    } catch (_e) { bh.harvestWarnings.push('rejection_capture_threw:' + String(_e)); bh.sync(); }
  });
})();`;

module.exports = { BOOTSTRAP_SOURCE };
