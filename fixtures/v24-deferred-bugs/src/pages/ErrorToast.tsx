// dom_error_text: clicking the button reveals error text in the DOM.
// CHECK_DOM_ERROR_SCRIPT detects "Something went wrong" appearing post-action.

import React, { useState } from 'react';

export function ErrorToast({ navigate }: { navigate: (path: string) => void }) {
  const [showError, setShowError] = useState(false);

  return (
    <main>
      <h1>Error Toast</h1>
      <p>Clicking the button reveals error text → dom_error_text</p>
      <a href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>Home</a>
      <br />
      <button id="trigger-error" onClick={() => setShowError(true)}>
        Trigger Error
      </button>
      {showError && (
        <div id="error-toast" role="alert">Something went wrong</div>
      )}
    </main>
  );
}
