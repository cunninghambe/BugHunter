// Positive: hardcoded user-facing strings, no t() wrapping.
import React from 'react';

export function HardcodedComponent() {
  return (
    <div>
      <h1>Welcome to our store</h1>
      <p>Browse our latest products.</p>
      <button>Add to cart</button>
    </div>
  );
}

export const HARDCODED_LABEL = 'Order summary';
