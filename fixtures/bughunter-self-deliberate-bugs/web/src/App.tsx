import React from 'react';
import ConsoleError from './pages/ConsoleError.js';
import ReactError from './pages/ReactError.js';
import Unhandled from './pages/Unhandled.js';
import MissingStateChange from './pages/MissingStateChange.js';
import ClickNoName from './pages/ClickNoName.js';
import XssDom from './pages/XssDom.js';
import SlowLcp from './pages/SlowLcp.js';
import SlowInp from './pages/SlowInp.js';
import Cls from './pages/Cls.js';
import NPlusOne from './pages/NPlusOne.js';
import Dedup from './pages/Dedup.js';
import LongTask from './pages/LongTask.js';
import Rerender from './pages/Rerender.js';
import DeadLink from './pages/DeadLink.js';
import MemoryLeak from './pages/MemoryLeak.js';
import VisualAnomaly from './pages/VisualAnomaly.js';
import CsrfMissing from './pages/CsrfMissing.js';
import Hallucinated from './pages/Hallucinated.js';
import NavCorruption from './pages/NavCorruption.js';
import NavResubmit from './pages/NavResubmit.js';
import NavRefresh from './pages/NavRefresh.js';
import NavFormLost from './pages/NavFormLost.js';
import NavFormStale from './pages/NavFormStale.js';
import MobileBugs from './pages/MobileBugs.js';
import Bloat from './bloat.js';

// Bloat import ensures oversized_bundle fires.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _bloatRef = Bloat;

const ROUTES: Record<string, () => React.ReactElement> = {
  '/console-error': () => React.createElement(ConsoleError),
  '/react-error': () => React.createElement(ReactError),
  '/unhandled': () => React.createElement(Unhandled),
  '/no-state-change': () => React.createElement(MissingStateChange),
  '/click-no-name': () => React.createElement(ClickNoName),
  '/xss-dom': () => React.createElement(XssDom),
  '/slow-lcp': () => React.createElement(SlowLcp),
  '/slow-inp': () => React.createElement(SlowInp),
  '/cls': () => React.createElement(Cls),
  '/n-plus-one': () => React.createElement(NPlusOne),
  '/dedup': () => React.createElement(Dedup),
  '/long-task': () => React.createElement(LongTask),
  '/rerender': () => React.createElement(Rerender),
  '/dead-link': () => React.createElement(DeadLink),
  '/memory-leak': () => React.createElement(MemoryLeak),
  '/visual-anomaly': () => React.createElement(VisualAnomaly),
  '/csrf-missing': () => React.createElement(CsrfMissing),
  '/hallucinated': () => React.createElement(Hallucinated),
  '/nav-corruption': () => React.createElement(NavCorruption),
  '/nav-resubmit': () => React.createElement(NavResubmit),
  '/nav-refresh': () => React.createElement(NavRefresh),
  '/nav-form-lost': () => React.createElement(NavFormLost),
  '/nav-form-stale': () => React.createElement(NavFormStale),
  '/mobile-bugs': () => React.createElement(MobileBugs),
};

export default function App(): React.ReactElement {
  const path = window.location.pathname;
  const handler = ROUTES[path];
  if (handler) return handler();
  return React.createElement('div', null,
    React.createElement('h1', null, 'BugHunter Self-Test Fixture'),
    React.createElement('p', null, 'Deliberately buggy pages for regression testing. DO NOT DEPLOY.'),
    React.createElement('ul', null,
      Object.keys(ROUTES).map(r =>
        React.createElement('li', { key: r },
          React.createElement('a', { href: r }, r),
        ),
      ),
    ),
  );
}
