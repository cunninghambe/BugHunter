import React from 'react';

type Props = { navigate: (path: string) => void };

export function Landing({ navigate }: Props) {
  return (
    <main>
      <h1>Landing</h1>
      <nav>
        <a href="/about"     onClick={(e) => { e.preventDefault(); navigate('/about'); }}>About</a>
        <a href="/login"     onClick={(e) => { e.preventDefault(); navigate('/login'); }}>Login</a>
        <a href="/dashboard" onClick={(e) => { e.preventDefault(); navigate('/dashboard'); }}>Dashboard</a>
      </nav>
      <a href="https://vitejs.dev" target="_blank" rel="noreferrer">Vite docs</a>
    </main>
  );
}
