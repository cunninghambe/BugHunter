import React from 'react';

type Props = { navigate: (path: string) => void };

export function Dashboard({ navigate }: Props) {
  return (
    <main>
      <h1>Dashboard</h1>
      <nav>
        <a href="/about" onClick={(e) => { e.preventDefault(); navigate('/about'); }}>About</a>
        <a href="/"      onClick={(e) => { e.preventDefault(); navigate('/'); }}>Home</a>
      </nav>
    </main>
  );
}
