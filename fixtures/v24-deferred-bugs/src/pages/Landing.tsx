import React from 'react';

export function Landing({ navigate }: { navigate: (path: string) => void }) {
  return (
    <main>
      <h1>V24 Deferred Bug Fixture</h1>
      <p>Each route below demonstrates a deferred BugKind.</p>
      <nav>
        <ul>
          <li><a href="/long-list" onClick={e => { e.preventDefault(); navigate('/long-list'); }}>unbounded_list_render</a></li>
          <li><a href="/error-toast" onClick={e => { e.preventDefault(); navigate('/error-toast'); }}>dom_error_text</a></li>
          <li><a href="/hydration" onClick={e => { e.preventDefault(); navigate('/hydration'); }}>hydration_mismatch</a></li>
          <li><a href="/cancel" onClick={e => { e.preventDefault(); navigate('/cancel'); }}>request_cancellation_missing</a></li>
          <li><a href="/a11y" onClick={e => { e.preventDefault(); navigate('/a11y'); }}>accessibility_critical</a></li>
        </ul>
      </nav>
    </main>
  );
}
