import React from 'react';

export default function NavRefresh(): React.ReactElement {
  function handleClick() {
    // SELF-TEST: triggers nav_refresh_double_mutation — mutates state, then simulates refresh re-mutation
    fetch('/api/csrf-mutate', { method: 'POST' }).catch(() => undefined);
    // Immediately re-fire (simulates double mutation on refresh)
    setTimeout(() => fetch('/api/csrf-mutate', { method: 'POST' }).catch(() => undefined), 10);
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Nav Refresh Double Mutation Page'),
    React.createElement('button', { onClick: handleClick, id: 'refresh-mutate-btn' }, 'Mutate (fires twice)'),
    React.createElement('p', null, 'Clicking above fires the same mutation twice to trigger nav_refresh_double_mutation.'),
  );
}
