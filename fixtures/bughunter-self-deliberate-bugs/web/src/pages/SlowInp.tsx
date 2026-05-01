import React from 'react';

export default function SlowInp(): React.ReactElement {
  function handleClick() {
    // SELF-TEST: triggers slow_inp — 500ms blocking work on click
    const end = Date.now() + 500;
    while (Date.now() < end) { /* busy-wait */ }
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Slow INP Page'),
    React.createElement('button', { onClick: handleClick, id: 'slow-inp-btn' }, 'Click me (blocks 500ms)'),
    React.createElement('p', null, 'Clicking the button runs 500ms of synchronous work to trigger slow INP.'),
  );
}
