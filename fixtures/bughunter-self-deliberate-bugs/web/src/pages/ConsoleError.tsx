import React, { useEffect } from 'react';

export default function ConsoleError(): React.ReactElement {
  useEffect(() => {
    // SELF-TEST: triggers console_error
    console.error('SELF-TEST CONSOLE ERROR ' + Math.random());
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'Console Error Page'),
    React.createElement('p', null, 'This page emits a console.error on mount.'),
  );
}
