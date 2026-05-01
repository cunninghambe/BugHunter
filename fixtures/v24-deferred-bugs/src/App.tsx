// V24 deferred-bugs fixture — SPA router for 5 buggy routes.
// Each route demonstrates one of the deferred BugKinds.

import React, { useState, useEffect } from 'react';
import { Landing } from './pages/Landing.js';
import { LongList } from './pages/LongList.js';
import { ErrorToast } from './pages/ErrorToast.js';
import { HydrationPage } from './pages/Hydration.js';
import { CancelPage } from './pages/Cancel.js';
import { A11yPage } from './pages/A11y.js';

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

  if (page === '/long-list')   return <LongList navigate={navigate} />;
  if (page === '/error-toast') return <ErrorToast navigate={navigate} />;
  if (page === '/hydration')   return <HydrationPage navigate={navigate} />;
  if (page === '/cancel')      return <CancelPage navigate={navigate} />;
  if (page === '/a11y')        return <A11yPage navigate={navigate} />;
  return <Landing navigate={navigate} />;
}
