import React from 'react';

type Props = { navigate: (path: string) => void };

export function About({ navigate }: Props) {
  return (
    <main>
      <h1>About</h1>
      <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Home</a>
    </main>
  );
}
