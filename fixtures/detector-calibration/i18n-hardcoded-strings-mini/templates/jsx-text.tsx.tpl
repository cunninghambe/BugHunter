// Edge: JSX text nodes with raw English text — should fire on each.
import React from 'react';

export function JsxText() {
  return (
    <section>
      <h2>Featured collection</h2>
      <p>Discover our handpicked selection</p>
    </section>
  );
}
