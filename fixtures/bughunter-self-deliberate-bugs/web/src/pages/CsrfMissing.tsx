import React from 'react';

export default function CsrfMissing(): React.ReactElement {
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // SELF-TEST: triggers csrf_missing_on_mutating_route — POST with no CSRF token
    fetch('/api/csrf-mutate', { method: 'POST' }).catch(() => undefined);
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'CSRF Missing Page'),
    React.createElement('form', { onSubmit: handleSubmit },
      React.createElement('button', { type: 'submit', id: 'csrf-btn' }, 'Submit (no CSRF token)'),
    ),
    React.createElement('p', null, 'The form above submits to a mutating endpoint without any CSRF token.'),
  );
}
