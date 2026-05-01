import React, { useEffect } from 'react';

export default function LongTask(): React.ReactElement {
  useEffect(() => {
    // SELF-TEST: triggers main_thread_blocked — 250ms synchronous CPU work on mount
    const end = Date.now() + 250;
    while (Date.now() < end) { /* busy-wait to block main thread */ }
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'Main Thread Blocked Page'),
    React.createElement('p', null, 'On mount, this page runs 250ms of synchronous CPU work.'),
  );
}
