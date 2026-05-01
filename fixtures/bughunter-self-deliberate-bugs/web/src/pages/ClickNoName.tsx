import React from 'react';

export default function ClickNoName(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Interactive Element Missing Accessible Name'),
    // SELF-TEST: triggers interactive_element_missing_accessible_name
    React.createElement('button', { id: 'x' }),
    React.createElement('p', null, 'The button above has no accessible name (empty, no aria-label, no children).'),
  );
}
