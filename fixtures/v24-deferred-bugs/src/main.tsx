import React from 'react';
import ReactDOM from 'react-dom/client';
import axe from 'axe-core';
import { App } from './App.js';

// Load axe-core onto window so AXE_RUN_SCRIPT (accessibility.ts) can call window.axe.run.
// This enables accessibility_critical delta detection on this fixture.
(window as unknown as { axe: typeof axe }).axe = axe;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
