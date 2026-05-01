// request_cancellation_missing: clicking the button starts two long-running fetches
// then immediately navigates away, leaving requests in-flight without cancellation.
// classifyCancelMissing detects requests that started before nav and completed after.

import React from 'react';

export function CancelPage({ navigate }: { navigate: (path: string) => void }) {
  function handleClick() {
    // Start two slow fetches (they'll complete after the navigation).
    // Using httpbin.org or a local dev server with delay — for fixture purposes,
    // we use a URL that will 404 (but still gets a response status > 0).
    fetch('http://localhost:5780/?slow=1').catch(() => undefined);
    fetch('http://localhost:5780/?slow=2').catch(() => undefined);

    // Navigate away immediately — the fetches are now "abandoned" in-flight.
    // classifyCancelMissing detects this pattern when NavigationEvents show a nav
    // occurred while requests were still pending.
    setTimeout(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, 50);
  }

  return (
    <main>
      <h1>Request Cancellation</h1>
      <p>Clicking starts fetches and then navigates → request_cancellation_missing</p>
      <a href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>Home</a>
      <br />
      <button id="trigger-cancel" onClick={handleClick}>
        Trigger Cancellation
      </button>
    </main>
  );
}
