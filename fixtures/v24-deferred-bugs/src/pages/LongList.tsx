// unbounded_list_render: renders 200 table rows without virtualization.
// classifyUnboundedList fires when rowCount > ROW_THRESHOLD (default 100).

import React from 'react';

const ROWS = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `Item ${i}`, value: i * 3 }));

export function LongList({ navigate }: { navigate: (path: string) => void }) {
  return (
    <main>
      <h1>Long List</h1>
      <p>Renders 200 rows without virtualization → unbounded_list_render</p>
      <a href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>Home</a>
      <table>
        <thead>
          <tr><th>ID</th><th>Name</th><th>Value</th></tr>
        </thead>
        <tbody>
          {ROWS.map(row => (
            <tr key={row.id}>
              <td>{row.id}</td>
              <td>{row.name}</td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
