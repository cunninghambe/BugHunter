import React, { useState } from 'react';

export default function NavFormStale(): React.ReactElement {
  const [serverValue] = useState('server-value-v1');
  const [inputValue, setInputValue] = useState('');

  function handleLoad() {
    // SELF-TEST: triggers nav_form_state_stale — form shows stale (cached) value after server update
    setInputValue('stale-cached-value');
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Nav Form State Stale Page'),
    React.createElement('p', null, `Server value: ${serverValue}`),
    React.createElement('form', null,
      React.createElement('input', {
        type: 'text',
        value: inputValue,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInputValue(e.target.value),
        name: 'field',
        placeholder: 'Form field (may be stale)',
      }),
      React.createElement('button', { type: 'button', onClick: handleLoad, id: 'load-stale-btn' }, 'Load (loads stale value)'),
    ),
    React.createElement('p', null, 'Clicking Load populates the form with a stale cached value instead of the current server value.'),
  );
}
