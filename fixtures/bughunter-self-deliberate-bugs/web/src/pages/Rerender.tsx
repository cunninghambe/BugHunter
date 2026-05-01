import React, { useEffect, useState } from 'react';

export default function Rerender(): React.ReactElement {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // SELF-TEST: triggers excessive_re_renders — setState in useEffect with no deps causes infinite loop
    setCount(c => c + 1);
  });

  return React.createElement('div', null,
    React.createElement('h1', null, 'Excessive Re-renders Page'),
    React.createElement('p', null, `Render count: ${count}`),
    React.createElement('p', null, 'setState in useEffect with no dependency array triggers infinite re-render.'),
  );
}
