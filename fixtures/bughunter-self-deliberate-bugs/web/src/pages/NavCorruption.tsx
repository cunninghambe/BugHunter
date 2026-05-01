import React, { useState } from 'react';

export default function NavCorruption(): React.ReactElement {
  const [, setStep] = useState(0);

  function handleNavigate() {
    setStep(s => s + 1);
    // SELF-TEST: triggers nav_state_corruption — pushes an inconsistent history state
    window.history.pushState({ corrupt: true, url: '/nav-corruption' }, '', '/nav-corruption#corrupt');
    window.history.pushState({ corrupt: true, url: '/nav-corruption-x' }, '', '/nav-corruption-y');
  }

  return React.createElement('div', null,
    React.createElement('h1', null, 'Nav State Corruption Page'),
    React.createElement('button', { onClick: handleNavigate, id: 'nav-corrupt-btn' }, 'Navigate (corrupts state)'),
    React.createElement('p', null, 'Clicking above pushes mismatched history states, triggering nav_state_corruption.'),
  );
}
