import React, { useEffect } from 'react';

export default function XssDom(): React.ReactElement {
  useEffect(() => {
    // SELF-TEST: triggers xss_dom — reads location.hash and writes to innerHTML
    document.body.innerHTML = window.location.hash.slice(1);
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'DOM XSS Page'),
    React.createElement('p', null, 'This page reads location.hash and writes it to document.body.innerHTML.'),
  );
}
