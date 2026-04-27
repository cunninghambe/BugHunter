// Hand-rolled tab-state routing (no react-router-dom).
// SurfaceMCP cannot statically extract routes → emits crawl_seed at '/'.
// BugHunter crawls outward via the <a href> links on each page.

import React, { useState, useEffect } from 'react';
import { Landing } from './pages/Landing.js';
import { About } from './pages/About.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';

function getPage(): string {
  return window.location.pathname;
}

export function App() {
  const [page, setPage] = useState(getPage);

  useEffect(() => {
    const handler = () => setPage(getPage());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  function navigate(path: string) {
    window.history.pushState({}, '', path);
    setPage(path);
  }

  if (page === '/about')     return <About     navigate={navigate} />;
  if (page === '/login')     return <Login     navigate={navigate} />;
  if (page === '/dashboard') return <Dashboard navigate={navigate} />;
  return <Landing navigate={navigate} />;
}
