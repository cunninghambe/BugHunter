// Deliberately broken browser-platform fixture for v0.36 smoke tests.
//
// Each route exposes one bad browser-platform pattern:
//   /sw-stale             — serves a SW that never calls skipWaiting()
//   /worker-error         — loads a Web Worker that immediately throws
//   /iframe-unguarded     — postMessage listener with no origin check
//   /shadow-bad-contrast  — shadow DOM host with low-contrast text
//   /perm-denied          — geolocation call with no error handler
//   /webrtc-fail          — RTCPeerConnection with no ice failure handler
//   /sri-block            — script with wrong integrity hash
//   /coop-coep-bad        — page references SharedArrayBuffer without COOP/COEP
//   /trusted-types-violate — page triggers a Trusted Types CSP violation

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = parseInt(process.env.PORT ?? '5793', 10);

function html(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const ROUTES = {
  '/sw-stale': () => html('SW Stale', `
    <h1>Service Worker Stale</h1>
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/sw-stale/' });
      }
    </script>
  `),

  '/worker-error': () => html('Worker Error', `
    <h1>Web Worker Error</h1>
    <script>
      const w = new Worker('/worker.js');
      // No error handler — web_worker_error detection target
    </script>
  `),

  '/iframe-unguarded': () => html('iframe Unguarded postMessage', `
    <h1>Unguarded postMessage</h1>
    <script>
      // Listener with no event.origin check — iframe_postmessage_unguarded target
      window.addEventListener('message', function(event) {
        document.body.setAttribute('data-msg', event.data);
      });
    </script>
  `),

  '/shadow-bad-contrast': () => html('Shadow DOM A11y', `
    <h1>Shadow DOM with bad contrast</h1>
    <script>
      class BadContrast extends HTMLElement {
        constructor() {
          super();
          const shadow = this.attachShadow({ mode: 'open' });
          // Light gray text on white background — fails color-contrast
          shadow.innerHTML = '<p style="color:#aaa;background:#fff">Low contrast text inside shadow DOM</p>';
        }
      }
      customElements.define('bad-contrast', BadContrast);
      document.body.appendChild(document.createElement('bad-contrast'));
    </script>
  `),

  '/perm-denied': () => html('Permission Denied', `
    <h1>Permission Denied Unhandled</h1>
    <script>
      // Calls geolocation with no error callback — permission_denied_unhandled target
      navigator.geolocation.getCurrentPosition(function(pos) {
        console.log(pos);
      });
      // No error handler passed
    </script>
  `),

  '/webrtc-fail': () => html('WebRTC ICE Failure', `
    <h1>WebRTC ICE Failure</h1>
    <script>
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:0.0.0.0:1' }] });
        // No iceconnectionstatechange handler — webrtc_ice_failure detection target
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {});
      } catch (_) {}
    </script>
  `),

  '/sri-block': () => html('SRI Block', `
    <h1>SRI Block</h1>
    <!-- Wrong integrity hash — browser will block this script -->
    <script src="/bad-integrity.js"
      integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      crossorigin="anonymous"></script>
  `),

  '/coop-coep-bad': () => html('COOP/COEP Bad', `
    <h1>COOP/COEP Bad</h1>
    <script>
      // References SharedArrayBuffer without crossOriginIsolated — coop_coep_violation target
      try {
        const sab = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(16) : null;
        window.__sabRef = sab;
      } catch (_) {
        window.__sabRef = null;
      }
    </script>
  `),

  '/trusted-types-violate': () => html('Trusted Types Violation', `
    <h1>Trusted Types Violation</h1>
    <meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">
    <script>
      // This assignment violates Trusted Types — trusted_types_violation detection target
      try {
        document.querySelector('h1').innerHTML = '<span>injected</span>';
      } catch (e) {
        console.error('Trusted Types violation:', e);
      }
    </script>
  `),
};

const STATIC = {
  '/sw.js': {
    type: 'text/javascript',
    // Deliberate: installs but never calls skipWaiting() — stays in waiting state
    body: `
self.addEventListener('install', function(event) {
  // Missing: event.waitUntil(self.skipWaiting())
  console.log('[SW] installed without skipWaiting');
});
self.addEventListener('activate', function(event) {
  console.log('[SW] activated');
});
    `,
  },

  '/worker.js': {
    type: 'text/javascript',
    // Deliberately throws on load — web_worker_error detection target
    body: `throw new Error('Worker intentionally failed for v0.36 test');`,
  },

  '/bad-integrity.js': {
    type: 'text/javascript',
    body: `console.log('sri test');`,
  },
};

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url ?? '/');

  if (STATIC[pathname] !== undefined) {
    res.writeHead(200, { 'Content-Type': STATIC[pathname].type });
    res.end(STATIC[pathname].body);
    return;
  }

  const handler = ROUTES[pathname];
  if (handler === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(handler());
});

server.listen(PORT, () => {
  process.stdout.write(`browser-platform-bad fixture on port ${PORT}\n`);
});
