import React from 'react';

type Props = { navigate: (path: string) => void };

export function Login({ navigate }: Props) {
  return (
    <main>
      <h1>Login</h1>
      <form action="/api/login" method="POST" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" />
        <button type="submit">Sign in</button>
      </form>
      <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Home</a>
    </main>
  );
}
