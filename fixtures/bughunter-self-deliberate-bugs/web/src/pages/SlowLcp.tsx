import React from 'react';

export default function SlowLcp(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Slow LCP Page'),
    // SELF-TEST: triggers slow_lcp — LCP image served with 4s delay from API
    React.createElement('img', {
      src: '/slow.png',
      alt: 'Slow-loading LCP image',
      style: { width: '100%', height: '400px', objectFit: 'cover' },
    }),
    React.createElement('p', null, 'The image above is served with a 4-second delay to trigger slow LCP detection.'),
  );
}
