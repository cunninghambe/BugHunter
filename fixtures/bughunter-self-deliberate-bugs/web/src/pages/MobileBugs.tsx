import React from 'react';

// SELF-TEST: triggers touch_target_too_small — button is 30x30px (below 44x44 minimum)
// SELF-TEST: triggers font_too_small_on_mobile — paragraph uses 10px font (below 12px minimum)
export default function MobileBugs(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Mobile Bugs Page'),
    React.createElement('button', {
      style: { width: '20px', height: '20px', padding: '0' },
    }, 'X'),
    React.createElement('p', {
      style: { fontSize: '10px' },
    }, 'This text is intentionally too small to read on mobile.'),
  );
}
