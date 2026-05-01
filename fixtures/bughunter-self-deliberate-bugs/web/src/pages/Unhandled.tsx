import React, { useEffect } from 'react';

export default function Unhandled(): React.ReactElement {
  useEffect(() => {
    // SELF-TEST: triggers unhandled_exception
    setTimeout(() => { throw new Error('SELF-TEST UNCAUGHT ASYNC'); }, 50);
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'Unhandled Exception Page'),
    React.createElement('p', null, 'This page throws an unhandled async exception after 50ms.'),
  );
}
