// hydration_mismatch: deliberately logs a hydration-mismatch-like console error.
// In a real app this would come from mismatched SSR/client render.
// Here we simulate it by logging the pattern on mount.

import React, { useEffect } from 'react';

export function HydrationPage({ navigate }: { navigate: (path: string) => void }) {
  useEffect(() => {
    // Simulate the React hydration mismatch error that classifyReactErrors detects.
    // A real hydration mismatch is produced by React when server/client HTML differ.
    console.error('Hydration failed because the initial UI does not match what was rendered on the server.');
  }, []);

  return (
    <main>
      <h1>Hydration Page</h1>
      <p>Logs a hydration-mismatch console error on mount → hydration_mismatch</p>
      <a href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>Home</a>
      <br />
      <button id="trigger-hydration" onClick={() => {
        console.error('Hydration failed because the initial UI does not match what was rendered on the server.');
      }}>
        Trigger Hydration Error
      </button>
    </main>
  );
}
