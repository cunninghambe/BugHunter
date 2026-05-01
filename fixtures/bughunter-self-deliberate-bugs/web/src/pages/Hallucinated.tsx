import React from 'react';

export default function Hallucinated(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Hallucinated Route Page'),
    // SELF-TEST: triggers hallucinated_route — links to routes that are referenced but never defined
    React.createElement('nav', null,
      React.createElement('a', { href: '/does-not-exist-hallucinated-1' }, 'Dashboard'),
      React.createElement('a', { href: '/does-not-exist-hallucinated-2' }, 'Reports'),
      React.createElement('a', { href: '/does-not-exist-hallucinated-3' }, 'Settings'),
    ),
    React.createElement('p', null, 'The nav links above reference routes that do not exist in the router.'),
  );
}
