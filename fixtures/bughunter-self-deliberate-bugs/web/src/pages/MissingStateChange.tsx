import React from 'react';

export default function MissingStateChange(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Missing State Change Page'),
    // SELF-TEST: triggers missing_state_change — button has no click handler
    React.createElement('button', { id: 'ghost-btn' }, 'Save'),
    React.createElement('p', null, 'The Save button above has no click handler.'),
  );
}
