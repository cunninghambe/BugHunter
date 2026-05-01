import React, { useEffect, useState } from 'react';

export default function Cls(): React.ReactElement {
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    // SELF-TEST: triggers high_cls — late-mounting card causes 400px layout shift
    const t = setTimeout(() => setShowCard(true), 800);
    return () => clearTimeout(t);
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'High CLS Page'),
    // Image with no explicit dimensions causes layout shift
    React.createElement('img', { src: '/slow.png', alt: 'No-size image' }),
    React.createElement('p', null, 'Text that shifts down when the card appears below.'),
    showCard
      ? React.createElement('div', {
          style: { height: '400px', background: '#eee', marginTop: '0' },
        }, 'Late-mounted card — causes CLS')
      : null,
  );
}
