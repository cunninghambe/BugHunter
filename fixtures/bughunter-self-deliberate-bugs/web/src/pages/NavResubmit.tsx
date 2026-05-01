import React from 'react';

export default function NavResubmit(): React.ReactElement {
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // SELF-TEST: triggers nav_resubmit_on_back — form posts, then navigating back re-submits
    fetch('/api/csrf-mutate', { method: 'POST' })
      .then(() => {
        window.history.pushState({}, '', '/nav-resubmit#submitted');
      })
      .catch(() => undefined);
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Nav Resubmit on Back Page'),
    React.createElement('form', { onSubmit: handleSubmit },
      React.createElement('input', { type: 'text', defaultValue: 'test', name: 'field' }),
      React.createElement('button', { type: 'submit', id: 'resubmit-btn' }, 'Submit'),
    ),
    React.createElement('p', null, 'Submit, then go Back — the form re-submits without a PRG pattern.'),
  );
}
