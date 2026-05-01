// accessibility_critical: clicking the button introduces a new critical axe violation
// by removing the label from the only interactive element on the page.
// classifyA11yDelta detects new critical/serious violations appearing post-action.

import React, { useState } from 'react';

export function A11yPage({ navigate }: { navigate: (path: string) => void }) {
  const [labelRemoved, setLabelRemoved] = useState(false);

  return (
    <main>
      <h1>Accessibility Delta</h1>
      <p>Clicking removes the aria-label → introduces a critical axe violation → accessibility_critical</p>
      <a href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>Home</a>
      <br />
      {!labelRemoved ? (
        <button
          id="remove-label"
          aria-label="Accessible button label"
          onClick={() => setLabelRemoved(true)}
        >
          Remove Accessible Label
        </button>
      ) : (
        // After click: button has no accessible name → axe "button-name" violation
        <button id="unlabeled-button" onClick={() => undefined}>
          {/* No accessible name: no text content, no aria-label */}
        </button>
      )}
    </main>
  );
}
