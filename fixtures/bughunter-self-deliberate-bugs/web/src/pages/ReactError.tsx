import React from 'react';

function Crasher(): React.ReactElement {
  // SELF-TEST: triggers react_error — throws on render, no error boundary wrapping this route
  throw new Error('SELF-TEST RENDER FAIL');
}

export default function ReactError(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'React Error Page'),
    React.createElement(Crasher),
  );
}
