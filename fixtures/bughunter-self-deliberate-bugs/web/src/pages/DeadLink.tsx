import React from 'react';

export default function DeadLink(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Dead Link Page'),
    // SELF-TEST: triggers 404_for_linked_route — links to a route that does not exist
    React.createElement('a', { href: '/this-route-does-not-exist-self-test' }, 'Broken link (404)'),
    React.createElement('p', null, 'The link above points to a non-existent route.'),
  );
}
