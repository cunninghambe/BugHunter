import React from 'react';

export default function NavFormLost(): React.ReactElement {
  function handleNavigate() {
    // SELF-TEST: triggers nav_form_state_lost — navigates away, form state lost on return
    window.location.href = '/';
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Nav Form State Lost Page'),
    React.createElement('form', null,
      React.createElement('input', { type: 'text', defaultValue: '', name: 'draft', placeholder: 'Type something...' }),
      React.createElement('button', { type: 'button', onClick: handleNavigate, id: 'nav-away-btn' }, 'Navigate Away'),
    ),
    React.createElement('p', null, 'Type in the field above, then click Navigate Away. The form state is lost on return.'),
  );
}
