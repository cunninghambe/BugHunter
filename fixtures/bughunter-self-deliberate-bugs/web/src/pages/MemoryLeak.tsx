import React, { useEffect } from 'react';

// SELF-TEST: triggers memory_leak_suspected and memory_leak_attributed
// A growing array that is never freed, creating a detectable heap leak.
const leakStore: object[] = [];

export default function MemoryLeak(): React.ReactElement {
  useEffect(() => {
    const interval = setInterval(() => {
      for (let i = 0; i < 100; i++) {
        leakStore.push({ id: i, payload: new Array(1000).fill(i), capturedAt: Date.now() });
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'Memory Leak Page'),
    React.createElement('p', null, 'This page grows a closure-captured array without bound to trigger heap leak detection.'),
  );
}
