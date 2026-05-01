import React, { useEffect } from 'react';

export default function Dedup(): React.ReactElement {
  useEffect(() => {
    // SELF-TEST: triggers request_dedup_missing — same endpoint fetched 4x within 100ms
    fetch('/api/foo').catch(() => undefined);
    setTimeout(() => fetch('/api/foo').catch(() => undefined), 25);
    setTimeout(() => fetch('/api/foo').catch(() => undefined), 50);
    setTimeout(() => fetch('/api/foo').catch(() => undefined), 75);
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'Request Dedup Missing Page'),
    React.createElement('p', null, 'Makes the same fetch call 4 times within 100ms without deduplication.'),
  );
}
