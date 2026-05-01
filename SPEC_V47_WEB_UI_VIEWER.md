# SPEC — v0.47 "Web UI viewer"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor / dependencies:** v0.18 (V-spec format reference), v0.29 (per-kind severity), v0.30 (streaming MCP resources for live-tail) · **Phase G** of `SPEC_PATH_TO_EXHAUSTIVE.md` §8.6

This spec adds a standalone, read-only static **web UI** for browsing a `.bughunter/runs/<id>/` directory. The viewer is shipped as a static SPA (Vite + React + zero non-UI dependencies) bundled inside the `@bughunter/cli` package and surfaced via `bughunter view`. Users open a directory locally with the **File System Access API** (`window.showDirectoryPicker()`), the SPA loads `bugs.jsonl`, `summary.json`, action logs, and screenshots in-browser, and renders a cluster tree with drill-downs, filters, search, and (for in-progress runs) a live-tail view fed by the streaming MCP resources defined in v0.30. There is no backend, no persistent state, no server-side rendering. The CLI subcommand merely serves the static asset bundle on a free localhost port and opens the user's browser at it.

---

## 1. Objective

Add the fifth client surface (CLI / IDE / CI / Slack / **Web UI**) to BugHunter so that a non-technical reviewer — designer, PM, security lead, founder — can triage a run without touching a terminal beyond `bughunter view`. The viewer is read-only: it never mutates the run directory, never calls back to a server, never phones home.

In scope:
- A new package `packages/viewer/` containing a Vite + React static SPA that runs entirely in the browser.
- A new `bughunter view` CLI subcommand that serves the bundled SPA on a free localhost port and opens the default browser at it.
- File System Access API (FS Access API) directory picker for loading `.bughunter/runs/<id>/`.
- Cluster list + cluster detail views with screenshots, action timelines, console errors, network requests.
- Filter and search: by `BugKind`, role, severity (v0.29), verdict, page route, free text in `rootCause`.
- Live-tail mode for in-progress runs, driven by the v0.30 streaming MCP resources.

Out of scope (deferred):
- Triage actions (mark verdict, suppress) — the viewer is read-only in v0.47. Editing requires a writable surface; that's a v0.48 follow-up that wires the FS Access write handle into the suppress / triage flows or routes to a local HTTP companion.
- Cross-run diffing / history (v0.49 — depends on Phase D `diff` / `history`).
- Authentication or hosting. The viewer is local-first; a hosted variant (`viewer.bughunter.dev` + drag-and-drop directory upload) is a v0.50 follow-up.
- Mobile / touch UX. Desktop-class browsers only (Chromium 86+, Edge 86+). Safari / Firefox FS Access support is partial; the spec falls back to a manual file picker (multi-file `<input type="file" webkitdirectory>`).

Acceptance target on the existing `vite-crawl-app` fixture:
- `bughunter view` opens a Chromium tab pointed at `http://127.0.0.1:<freePort>/`.
- User clicks "Open run directory", picks `/root/BugHunter/fixtures/vite-crawl-app/.bughunter/runs/<latest>/`, and within 1s sees a cluster list with the same count as `summary.json.bugs_filed`.
- Clicking a cluster opens a detail panel with the first occurrence's screenshot rendered, action timeline rendered as a vertical list, and console-error / network-request panes populated.
- Filter to `kind=console_error` reduces the list to only `console_error` clusters; clearing the filter restores it.
- Search for a string present in any cluster's `rootCause` narrows to that cluster.
- A run still in progress (poll `summary.json` every 1s; appearance of new clusters in `bugs.jsonl`) updates the cluster list without a page reload.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` | The on-disk JSONL shape (`BugCluster`, `BugDetection`, `Occurrence`, `RunSummary`). The viewer's TS types are derived from this file — copy verbatim into a shared types module; do NOT redefine. |
| `packages/cli/src/cli/main.ts` | Pattern for registering a new subcommand. Mirror the existing `list` / `inspect` / `prune` registration. |
| `packages/cli/src/cli/list.ts` | Pattern for reading `summary.json` + `bugs.jsonl` from `.bughunter/runs/<id>/`. The viewer's loader matches this file layout. |
| `packages/cli/src/store/filesystem.ts` | The on-disk run-directory layout: `bugs.jsonl`, `summary.json`, `action-logs/<occurrenceId>.json`, `screenshots/<occurrenceId>.png`, `dom/<occurrenceId>.html`, `console/<occurrenceId>.log`, `network/<occurrenceId>.har`. The viewer reads the same paths via FS Access handles. |
| `packages/cli/src/cli/inspect.ts` | The "render a cluster as text" logic — mirror its field-pulling order in the React detail panel for parity. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format we mirror here: numbered sections, edge cases, task breakdown, acceptance + done-when matrix, open questions. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §8.6 + §9 (Phase G) | Original framing: standalone, read-only, FS Access API, no backend. |

### 2.2 Patterns to follow

- **Types are the source of truth.** Re-use `packages/cli/src/types.ts` directly via a path-aliased import or a minimal re-export module — do NOT redeclare any of `BugCluster`, `BugDetection`, `Occurrence`, `RunSummary`, `BugKind`. The viewer must compile-error if the on-disk shape changes.
- **Discriminated unions over string conventions.** Every viewer state type is a discriminated union: `{ kind: 'idle' } | { kind: 'loading' } | { kind: 'loaded'; ... } | { kind: 'error'; reason: string }`. Per `/root/.claude/CLAUDE.md`, this is non-negotiable.
- **State lives in the URL.** Selected cluster id, active filters, search query, viewport are all reflected in `?kind=...&search=...&cluster=...&viewport=375`. Refreshing the page restores state. (Per `/root/.claude/CLAUDE.md` "URL is state".)
- **No server-state library.** The viewer reads files from a chosen directory; there is no API client. We do not pull in TanStack Query / SWR. Plain `useState` + a minimal directory loader hook suffice.
- **Zero non-UI dependencies.** React, React DOM, and one UI primitive layer (Radix UI primitives — unstyled, ~25KB gzipped) are the only runtime deps. No CSS framework — hand-written CSS Modules with PostCSS for nested selectors. No virtualization library; if a cluster list grows past 200 entries, we add `react-virtual` in v0.48.
- **Error boundaries at route level.** A single top-level boundary plus a per-cluster-detail boundary so a bad screenshot can't crash the cluster list.
- **Accessibility is not optional.** Keyboard navigation works for the entire viewer. Cluster list is a `<ul role="listbox">`, j/k selects, Enter opens. Per WCAG 2.1 AA.

### 2.3 DO NOT

- Do **not** create a new types package — re-use `packages/cli/src/types.ts`.
- Do **not** re-implement the BugHunter run reader. The viewer's loader is intentionally a thin wrapper that reads `bugs.jsonl` + `summary.json` from FS Access handles; it must NOT import anything from `packages/cli/src/store/`. The CLI `store/` is Node-only (uses `fs/promises`); the viewer is browser-only.
- Do **not** add a backend. `bughunter view` is a static-file server only; it must not expose any endpoint that reads the run directory or proxies anything.
- Do **not** call back to anthropic.com, segment, sentry, or any analytics endpoint. The viewer is local-first; opening it must not make any non-localhost network request.
- Do **not** persist any state to `localStorage` other than the optional last-opened directory handle (which is opt-in and explained to the user).
- Do **not** ship `react-router`. The viewer is a single page with URL search-params; that's a 60-line custom hook, not a 30KB dependency.

---

## 3. Stack + architectural decisions

### 3.1 Build stack

- **Vite** (5.x) for dev server + production bundling. We pick Vite over Next/Remix because the viewer is a true SPA — no SSR, no API routes, no backend at all. Vite's static output is a `dist/` directory of HTML + JS + CSS that can be served from any static server (including the one inside `bughunter view`).
- **React** 18 + **React DOM** 18. (React 19 is fine if `@bughunter/cli` is already on it; no preference.)
- **TypeScript** strict — same `tsconfig.json` discipline as the rest of the repo. No `any`. Strict null checks. `noUncheckedIndexedAccess: true`.
- **ESLint** + **Prettier** match the root `eslint.config.js`.
- **Radix UI primitives** for unstyled accessible components (Tooltip, Dialog, Tabs, Popover, ScrollArea). Tree-shakes per-primitive; total cost ~25KB gzipped after only importing what we use.
- **No CSS framework.** CSS Modules + PostCSS Nested. Each `.module.css` lives next to its component.
- **Bundle target:** ES2020. Brotli-compressed bundle target ≤ 200KB total (HTML + JS + CSS) for the initial route. Verified via `vite build --report` and a CI check that fails the build if the gzipped bundle exceeds 250KB.

### 3.2 Why no backend

The viewer reads only files the user explicitly granted access to (FS Access API). Adding a backend would either:

1. Re-introduce the trust problem ("does this server upload my bugs?") — no.
2. Require the user to point a Node process at `.bughunter/runs/<id>/` — same UX as `bughunter list`, defeats the purpose.

A static SPA reading local files via FS Access handles is the simplest possible delivery. It also means the viewer can later be hosted at a public URL and still work against a local directory (by using FS Access on the hosted page).

### 3.3 Package layout

```
packages/viewer/
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx                    # React entry — single render
    App.tsx                     # Router shell + global error boundary
    types.ts                    # Re-exports from packages/cli/src/types.ts
    fs/
      directory-loader.ts       # FS Access API wrapper — reads bugs.jsonl, summary.json, lists action-logs/screenshots
      directory-loader.test.ts  # Unit tests against a fakeFS implementation
      fallback-input.ts         # Multi-file <input webkitdirectory> fallback for Firefox/Safari
    state/
      url-state.ts              # useUrlState hook — read/write search params with discriminated-union safety
      filters.ts                # FilterState type, applyFilters pure fn + tests
    components/
      ClusterList/
        ClusterList.tsx
        ClusterList.module.css
        ClusterList.test.tsx
      ClusterDetail/
        ClusterDetail.tsx
        ClusterDetail.module.css
        ClusterDetail.test.tsx
      OccurrenceTimeline/       # action timeline, console errors, network requests
      Screenshot/               # lazy-loaded, falls back to "screenshot missing" tile
      FilterBar/
      SearchBox/
      EmptyState/
      ErrorBoundary/
      LiveTailIndicator/        # shows "tailing run X — N new clusters" when active
    live-tail/
      poll.ts                   # FS-poll fallback (re-read summary.json every 1s, diff)
      mcp-stream.ts             # v0.30 streaming MCP resource subscriber (when --mcp flag used)
```

### 3.4 CLI subcommand plumbing

```
packages/cli/src/cli/view.ts    # registers `bughunter view`
packages/cli/src/cli/main.ts    # adds the subcommand registration
```

The viewer's built `dist/` is copied into the CLI package at build time:

```
packages/cli/
  package.json                  # adds "files": [..., "viewer-dist/**"]
  build.mjs                     # post-build step: cp -r ../viewer/dist viewer-dist
  viewer-dist/                  # generated; .gitignored
```

This keeps the CLI distributable as a single npm package — `npm i -g @bughunter/cli` ships the viewer.

---

## 4. File System Access API integration

### 4.1 Directory picker entry point

`fs/directory-loader.ts` exports:

```ts
export type DirectoryLoadResult =
  | { kind: 'idle' }
  | { kind: 'unsupported'; reason: 'no_fs_access_api' }
  | { kind: 'cancelled' }
  | { kind: 'denied'; reason: string }
  | { kind: 'loading' }
  | { kind: 'invalid'; reason: 'no_summary_json' | 'no_bugs_jsonl' | 'malformed_summary' }
  | { kind: 'loaded'; handle: FileSystemDirectoryHandle; runId: string; summary: RunSummary; clusters: BugCluster[] };

export async function pickRunDirectory(): Promise<DirectoryLoadResult>;
export async function loadFromHandle(handle: FileSystemDirectoryHandle): Promise<DirectoryLoadResult>;
```

`pickRunDirectory()`:

1. Feature-detect `'showDirectoryPicker' in window`. If absent → `{ kind: 'unsupported' }`. Caller switches to `fallback-input.ts`.
2. Call `window.showDirectoryPicker({ mode: 'read', id: 'bughunter-run', startIn: 'documents' })`.
3. On user-cancel (the call rejects with `AbortError`) → `{ kind: 'cancelled' }`.
4. Pass the resulting `FileSystemDirectoryHandle` to `loadFromHandle()`.

`loadFromHandle(handle)`:

1. `handle.getFileHandle('summary.json')`. If `NotFoundError` → `{ kind: 'invalid', reason: 'no_summary_json' }`.
2. `summaryFile.text()`, parse JSON; on `SyntaxError` → `{ kind: 'invalid', reason: 'malformed_summary' }`.
3. `handle.getFileHandle('bugs.jsonl')`. If absent → `{ kind: 'invalid', reason: 'no_bugs_jsonl' }`.
4. Stream `bugs.jsonl` line-by-line (`.stream()` → `TextDecoderStream` → `getReader()`), JSON.parse each line, validate via a Zod schema mirroring `BugCluster`. Skip + log malformed lines (do not abort the load — old runs may have schema drift).
5. Return `{ kind: 'loaded', handle, runId: summary.runId, summary, clusters }`.

### 4.2 On-demand artifact loading (screenshot, action log, etc.)

The cluster list shows ~all clusters, but the action timeline / screenshot / console / network logs are lazy-loaded only when a cluster's detail panel opens.

```ts
export async function loadOccurrenceArtifacts(
  rootHandle: FileSystemDirectoryHandle,
  occurrenceId: string,
): Promise<{
  screenshot?: Blob;          // .png; converted to object URL by caller
  actionLog?: ActionLogEntry[];  // parsed JSON
  consoleLog?: string;        // raw text
  networkLog?: HarFile;       // parsed HAR
}>;
```

Each artifact is loaded inside its own try/catch — a missing screenshot does not block the action log from rendering.

### 4.3 Permission persistence

FS Access handles can persist via IndexedDB (`indexedDB` + `idb-keyval`-style helpers, ~1KB hand-rolled). On reopen, the viewer detects a stored handle, calls `handle.queryPermission({ mode: 'read' })`, and if `'granted'` re-uses it without re-prompting. If `'prompt'`, the user clicks "Resume last run" → `requestPermission({ mode: 'read' })` re-prompts.

Persistence is opt-in via a checkbox on the directory picker. Default: off.

### 4.4 Fallback for Firefox / Safari

`fallback-input.ts` renders an `<input type="file" webkitdirectory multiple>` element. The user picks the same `runs/<id>/` directory. The browser delivers a flat `FileList`; we reconstruct relative paths from `webkitRelativePath` and present an in-memory `Map<string, File>` that exposes the same surface as a `FileSystemDirectoryHandle` (a tiny shim — `getFileHandle(name)` becomes `map.get(name)`).

The fallback does NOT support live-tail (no way to detect file changes from a one-shot picker). Live-tail UI is hidden when `kind === 'fallback'`.

---

## 5. Cluster list + detail UI

### 5.1 Cluster list (left rail)

- Renders one row per `BugCluster`. Sorted descending by `firstSeenAt` initially; sortable by clusterSize, severity (v0.29), kind.
- Row layout (single line, ellipsis on overflow):
  - Severity badge (color-coded — critical=red, major=orange, minor=yellow, informational=gray).
  - Kind label (e.g. `console_error`).
  - First occurrence's `pageRoute` (or '—' if absent).
  - `clusterSize` count badge (right-aligned).
- Selected row has aria-selected="true", visible focus ring, and is reflected in `?cluster=<id>`.
- Keyboard: `↑` / `↓` move selection, `j` / `k` aliases (vim-friendly), `Enter` opens detail (no-op when already focused — detail is always visible on desktop), `/` focuses the search box, `Esc` clears search.
- Screen-reader label: "Cluster {kind} on {pageRoute}, {clusterSize} occurrences, severity {severity}, first seen {firstSeenAt}".

### 5.2 Cluster detail (right pane)

Tabs (Radix `<Tabs>`):

1. **Overview** — kind, rootCause, severity, suspected files, fix hints, verdict, related cluster ids.
2. **Occurrences** — list of occurrences (collapsed); expanding one renders:
   - Screenshot (lazy-loaded; fades in; fallback "screenshot not available" tile).
   - Action timeline — vertical list of action-log entries.
   - Console errors — table with level / text / stack.
   - Network requests — table with method, path, status, duration; rows are color-coded by status range.
   - Pre/post state — URL, title, console-error count.
3. **Static / context** — for findings with `staticContext`, `injectionContext`, `xssContext`, `idorContext`, `headerContext`, `authFlowContext`, `raceContext`, `seoContext`, `a11yContext`, `heapContext`, `perfArtifacts` — each is rendered by a dedicated sub-component that knows the shape. Each sub-component re-uses the type from `packages/cli/src/types.ts` so adding a new context kind in BugHunter forces a viewer-side TS error (intentional).
4. **Raw** — pretty-printed JSON of the `BugCluster` for power users. Read-only `<pre>`.

### 5.3 Empty / loading / error states (per `/root/.claude/CLAUDE.md`)

Every data-fetching component has all four states:

- **Idle:** "No directory loaded. Click 'Open run directory' to begin."
- **Loading:** skeleton rows while `bugs.jsonl` streams.
- **Empty:** "Run completed cleanly — 0 clusters." Shows `summary.json` overview anyway (tests planned, runtime, vision telemetry).
- **Error:** specific message per `DirectoryLoadResult` discriminator. `unsupported` shows the fallback input. `denied` shows a re-pick button. `invalid` shows the exact missing/malformed file.

---

## 6. Filtering + search

### 6.1 Filter state

```ts
type FilterState = {
  kinds: BugKind[];          // empty = all
  roles: string[];           // empty = all
  severities: Severity[];    // v0.29; empty = all
  verdicts: ClusterVerdict[]; // empty = all
  pageRouteContains: string; // free text, empty = all
  thirdPartyOrGenerated: 'include' | 'exclude' | 'only';
};
```

`applyFilters(clusters, filterState, searchQuery): BugCluster[]` is a pure function; unit-tested with table-driven cases for every dimension and combinations.

### 6.2 Filter UI

- Filter bar above the cluster list. Each dimension is a Radix `<Popover>` with checkboxes. Active filters render as removable chips.
- Search box (top of list): debounced 200ms, matches case-insensitively against `cluster.rootCause`, `cluster.kind`, every `occurrence.page`, and `cluster.suspectedFiles`.
- All filter + search state is reflected in the URL: `?kind=console_error,react_error&severity=major,critical&search=hydration&cluster=cluster-abc`. URL is canonical; UI is derived.

### 6.3 Keyboard shortcuts

- `/` — focus search.
- `Esc` — clear search if focused; otherwise close any open popover.
- `f` followed by letter shortcuts (`fk` = filter kind, `fs` = filter severity) — opens the corresponding popover. Optional v0.47.1 follow-up if usability demands.

---

## 7. `bughunter view` CLI subcommand

### 7.1 Command surface

```
bughunter view [--port <n>] [--no-open] [--mcp <url>] [--run <runId>]
```

- `--port <n>` — bind to a specific port. Default: pick a free port via `getPort()`.
- `--no-open` — skip launching the browser. Useful for headless / SSH / dev environments where opening a browser is wrong.
- `--mcp <url>` — when provided, the viewer attempts to subscribe to the v0.30 streaming MCP resource at that URL for live-tail. When absent, live-tail uses FS-poll only (cf. §8.2).
- `--run <runId>` — when provided, embeds the run id into the URL so the viewer auto-loads the correct directory after the user grants permission. Without it, the viewer offers the standard directory picker.

### 7.2 Implementation

`packages/cli/src/cli/view.ts` (~80 lines):

```ts
export async function runViewCommand(opts: ViewOptions): Promise<void> {
  const port = opts.port ?? await getFreePort();
  const distDir = path.join(__dirname, '..', '..', 'viewer-dist');
  const server = http.createServer((req, res) => serveStatic(distDir, req, res));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}/${buildSearchParams(opts)}`;
  log.info(`Web UI viewer ready at ${url}`);
  if (!opts.noOpen) await openBrowser(url);
  // Stay alive until SIGINT.
  await new Promise(() => {});
}
```

- Use Node's stdlib `http` server — no Express, no Koa.
- `serveStatic` is hand-rolled (~30 lines): reads from `distDir`, sets `Content-Type` from extension, falls back to `index.html` for SPA routing, refuses any path containing `..` (defensive — distDir is shipped not user-controlled, but cheap insurance).
- `getFreePort()` uses a 0-bind trick on `net.createServer` (~10 lines).
- `openBrowser()` uses the cross-platform `open` package (~5KB) — explicitly justified because hand-rolling cross-platform browser launch is error-prone (xdg-open vs `start` vs `open`).

### 7.3 Headless server / SSH workflow

When `--no-open` is set or `process.env.SSH_TTY` is detected, the CLI prints:

```
Web UI viewer running at http://127.0.0.1:8765/
This appears to be a remote / headless session. To view from your laptop:
  ssh -L 8765:127.0.0.1:8765 you@this-host
Then open http://127.0.0.1:8765/ in your laptop's browser.
```

The user can also pass `--port 8765` to make the tunnel command predictable.

### 7.4 Security

- The HTTP server binds **only** to `127.0.0.1` — never to `0.0.0.0`. No port-forward without explicit user action (SSH tunnel).
- No CORS headers; the SPA only fetches its own bundled assets.
- No write endpoints. Even if the user proxies the port, there is nothing to write.

---

## 8. Live-tail for in-progress runs

A run-in-progress writes to `bugs.jsonl` as new clusters are minted. Two paths:

### 8.1 `--mcp <url>` path (preferred)

When `bughunter view --mcp http://127.0.0.1:<bughunterMcpPort>` is invoked, the viewer subscribes to the v0.30 streaming MCP resources:

- `bughunter://runs/<runId>/clusters/stream` — emits `BugCluster` JSON events as they're appended.
- `bughunter://runs/<runId>/summary/stream` — emits the rolling `RunSummary` snapshot.
- `bughunter://runs/<runId>/phase/stream` — emits `RunPhase` transitions for the progress indicator.

The viewer renders a `<LiveTailIndicator>` showing current phase, elapsed time, and a count of new clusters since the user last viewed. Each new cluster slides into the list with a subtle highlight that fades over 2s.

The MCP URL is passed to the SPA via a query string: `?mcp=http://127.0.0.1:3107`. The SPA opens an `EventSource` (Server-Sent Events) connection — v0.30 must support SSE for resource streams (already specced).

### 8.2 FS-poll fallback (no MCP available)

When no `--mcp` URL is provided AND the directory was opened via FS Access (not the fallback input), we can poll. Every 1500ms:

1. Re-read `summary.json`. If `summary.runId` differs OR `summary.bugs_filed` increased → reload `bugs.jsonl`.
2. Diff the new clusters against the previous list; show a "+N new" pill.
3. If `summary.actualRuntimeMs` is still increasing, the run is in-progress — keep polling.
4. If `summary` indicates `phase === 'done'` or `bugs_filed` has been stable for 30s, stop polling.

Cost is small — `summary.json` is sub-KB. We do NOT poll `bugs.jsonl` directly; only re-read it when `bugs_filed` changes.

The fallback `<input webkitdirectory>` path does NOT support live-tail (no way to re-read the directory after the initial pick). The viewer hides the live-tail indicator in that mode.

### 8.3 Failure modes

- MCP connection drops (`onerror`) → fall back to FS poll automatically; show a "live-tail downgraded" badge.
- FS poll throws (handle revoked, e.g. user moved the directory) → show the directory picker again; do not crash.

---

## 9. Distribution

### 9.1 Bundled inside `@bughunter/cli`

- `packages/viewer/` is built (`vite build`) before `packages/cli/` packages.
- `packages/cli/build.mjs` copies `../viewer/dist/` into `packages/cli/viewer-dist/`.
- `packages/cli/package.json` includes `viewer-dist/**` in `files`.
- `npm i -g @bughunter/cli` ships ~250KB extra (gzipped bundle target). Justified — Phase G's value is making the viewer trivial to launch, and forcing a separate package install defeats that.

### 9.2 Standalone `@bughunter/viewer` package (optional v0.47.1)

The viewer is also published as `@bughunter/viewer` so that hosted contexts (e.g. CI artifact viewers, Vercel deployments of a custom skin) can embed it. The published package contains the built `dist/` and exposes `index.html` as the entry. No additional code lives in the standalone package — it is a strict re-publish of `packages/viewer/dist/`.

This is a follow-up; v0.47 ships only the bundled-in-CLI variant.

### 9.3 Versioning

The viewer's version mirrors the CLI's — both ship from the same monorepo. The viewer reads `summary.viewerVersion` (new field in `RunSummary`, populated at run-emit time with the CLI version that produced the run) and shows a warning banner if the viewer's bundle version is older than the run's CLI version (likely schema drift). Banner text: "This run was produced by CLI vX.Y.Z; the viewer is on vA.B.C. Some fields may not render correctly. `npm i -g @bughunter/cli@latest` to upgrade."

This requires a one-line addition to `summary.json`: `viewerVersion?: string`. Backward-compatible (optional). Adding it to `types.ts` is part of Task 1.

---

## 10. Edge cases

### EC-1. `bugs.jsonl` contains a malformed line
The streaming parser logs a warning to the in-app debug panel and skips that line. The cluster list keeps loading. We do NOT block the entire viewer on one bad line — old runs commonly have schema drift.

### EC-2. `screenshots/<occurrenceId>.png` is missing
The screenshot pane shows a "screenshot not available" tile. The action timeline and console-error pane render normally. This was a deliberate design choice in v0.10 (`OccurrenceSummary` lacks artifacts); the viewer mirrors it.

### EC-3. User picks the wrong directory (e.g. `.bughunter/` instead of `.bughunter/runs/<id>/`)
The loader returns `{ kind: 'invalid', reason: 'no_summary_json' }`. The error UI explains: "This doesn't look like a BugHunter run directory. Try `.bughunter/runs/<id>/` instead." Add a "Show me which directory" link that points to a docs page with a screenshot.

### EC-4. FS Access API not supported (Firefox, Safari, older Chromium)
`pickRunDirectory()` returns `{ kind: 'unsupported' }`. UI swaps to the fallback `<input webkitdirectory>`. Live-tail is disabled.

### EC-5. User opens a run directory from a network drive / iCloud / Dropbox
FS Access works, but reads may be slow (~seconds for `bugs.jsonl`). The loading state must be visible (skeleton rows) and not give the impression of being broken. Add a "still loading…" message after 5s.

### EC-6. `bugs.jsonl` is huge (10k+ clusters)
The streaming parser is fine for parsing, but rendering 10k DOM rows is not. v0.47 caps the rendered list at 500 rows; a banner says "Showing 500 of 10,432 — narrow with filters or search." v0.48 adds `react-virtual` if real users hit this.

### EC-7. User opens two viewer tabs against the same run
Both work independently. Live-tail polls/streams independently. There is no shared state and no contention because the viewer is read-only.

### EC-8. User's chosen directory revokes permission (closed laptop, ejected drive)
Next read fails with `NotAllowedError`. Show the directory picker again with the message "Permission expired or directory unavailable. Please re-pick the run directory."

### EC-9. The run is mid-write when the viewer first reads `bugs.jsonl`
The last line may be a partial JSON (BugHunter writes lines atomically with `\n` terminator; until the `\n` lands the line is truncated). The streaming parser already skips malformed lines. On the next live-tail poll, the line will parse cleanly. No special handling beyond EC-1.

### EC-10. Severity is absent (pre-v0.29 runs)
The severity badge shows `unknown` (a fifth gray badge variant). Filter for severity treats the cluster as matching no severity-filter — i.e. it shows when the severity filter is empty (the default), and is hidden when any severity filter is active. This is acceptable because filtering by severity on a pre-v0.29 run is inherently undefined.

### EC-11. Two clusters with the same id (cross-run mixing)
The runId in `summary.json` is the source of truth. The viewer asserts every cluster's `runId` matches `summary.runId`; if not, the cluster is hidden and a debug-panel warning is logged. (Should never happen — this is an invariant — but defensive.)

### EC-12. Viewer version older than run CLI version
Banner per §9.3. Render the cluster list anyway with the fields the viewer knows about; unknown context shapes fall through to the "Raw" tab (which always renders the JSON regardless of TS-side knowledge).

### EC-13. Free port 8765 / 8766 / … all in use
`getFreePort()` keeps trying via `net.createServer().listen(0)` which lets the OS assign. No fixed-port retry loop.

### EC-14. User's default browser is broken / not installed (`open` throws)
Print the URL to stdout with a clear message: "Could not launch a browser automatically. Open this URL manually: http://127.0.0.1:8765/". Server keeps running; user can ctrl-C to stop.

### EC-15. Live-tail MCP connection is on a different origin
The SPA is served from `127.0.0.1:<freePort>`; the MCP is on `127.0.0.1:<bughunterMcpPort>`. SSE is same-host but cross-port — browsers treat this as cross-origin. The MCP server (v0.30) MUST send `Access-Control-Allow-Origin: http://127.0.0.1:*` for the resource-stream endpoints. Document this requirement in v0.30.

---

## 11. Test plan

### 11.1 Viewer unit tests (`packages/viewer/src/**/*.test.ts(x)`)

- `directory-loader.test.ts` — fakeFS implementation; covers all 7 `DirectoryLoadResult` discriminator variants. Includes a malformed `summary.json`, missing `bugs.jsonl`, malformed-but-valid-otherwise `bugs.jsonl` (one bad line), happy path.
- `filters.test.ts` — table-driven `applyFilters`: every filter dimension in isolation, two-dimension combinations, search OR'd with filters.
- `url-state.test.ts` — round-trip every filter / cluster / search combination through search params and back to FilterState.
- `ClusterList.test.tsx` — renders rows from a fixture, keyboard navigation moves selection, aria-selected updates, search narrows the list.
- `ClusterDetail.test.tsx` — renders Overview tab with and without each context kind; missing screenshot does not crash.
- `OccurrenceTimeline.test.tsx` — renders from a fixture action log; shows preState / postState; expands and collapses occurrences.
- `live-tail/poll.test.ts` — fakeFS + fakeTimers; new cluster appended → diff fires; `summary.bugs_filed` stable for 30s → polling stops.
- `live-tail/mcp-stream.test.ts` — mock EventSource; first `clusters/stream` event appends; connection drop falls back to poll path.

### 11.2 CLI integration tests (`packages/cli/tests/view.test.ts`)

- `bughunter view --no-open --port 0` — server starts, `GET /` returns 200 with the viewer's `index.html`, `GET /assets/<bundled>.js` returns 200, `GET /../etc/passwd` returns 400 (path traversal rejected).
- `bughunter view --port 0 --no-open --mcp http://127.0.0.1:9999` — URL printed includes `?mcp=http://127.0.0.1:9999`.
- `bughunter view --no-open` on a system with `SSH_TTY` set — output includes the SSH tunnel hint.

### 11.3 Smoke test (manual, scripted)

```bash
# 1. Run BugHunter against the existing fixture (or use a known run dir).
cd /root/BugHunter/fixtures/vite-crawl-app && \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 50 --budget 600000

# 2. Launch the viewer.
node /root/BugHunter/packages/cli/dist/cli/main.js view --no-open --port 8765 &
VIEWER_PID=$!

# 3. Curl-check the static server.
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/   # expect 200
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/index.html
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/../etc/passwd  # expect 400

# 4. Manual: open browser, click "Open run directory", pick the runs/<latest>/ folder.
#    Verify: cluster count matches summary.json, filter by kind narrows list,
#    search matches a known rootCause substring, opening a cluster shows
#    screenshot + action timeline + console errors.

kill $VIEWER_PID
```

### 11.4 Bundle-size CI gate

`packages/viewer/scripts/check-bundle-size.mjs` runs after `vite build`:

- Sums gzipped sizes of `dist/index.html` + `dist/assets/*.js` + `dist/assets/*.css`.
- Fails build if total > 250KB.
- Prints a per-file breakdown for diagnosis.

---

## 12. Negative requirements

- Do **not** introduce a server-side component beyond the static-file `bughunter view` HTTP server. No `/api/*` endpoints.
- Do **not** call any external (non-localhost) URL from the SPA at runtime. (Static assets are bundled; no CDN-loaded fonts; no Google Analytics.)
- Do **not** re-declare any types from `packages/cli/src/types.ts`. Re-export only.
- Do **not** add `react-router`, `redux`, `mobx`, `zustand`, `tanstack/query`, `swr`, `axios`, `date-fns`, `moment`, `lodash`, `tailwind`, `styled-components`, `emotion`, `chakra-ui`, `mui`, or any chart library. The viewer's deps are: `react`, `react-dom`, `@radix-ui/react-{tabs,dialog,popover,tooltip,scroll-area}`, and `vite` + `typescript` + `vitest` as dev deps. Adding anything else requires a spec amendment.
- Do **not** silently swallow errors. Every catch logs to the in-app debug panel. Empty `catch {}` blocks fail review.
- Do **not** include `as any`. Per `/root/.claude/CLAUDE.md`.
- Do **not** persist anything to `localStorage` other than the optional `lastDirectoryHandle` reference in IndexedDB (cf. §4.3).
- Do **not** support a hosted multi-tenant deployment in v0.47. The local-first model is the value; hosting comes later (v0.50) with explicit auth + isolation design.
- Do **not** ship analytics. Even error reporting is opt-in via `--report-errors` with a clear prompt.
- Do **not** allow the static server to bind to anything other than `127.0.0.1`.

---

## 13. Task breakdown

| # | Task | Assignee | Files | Deps |
|---|---|---|---|---|
| 1 | Add `viewerVersion?: string` to `RunSummary` in `types.ts`; populate at emit time. | `@coder` | `packages/cli/src/types.ts`, `packages/cli/src/phases/emit.ts` | none |
| 2 | Scaffold `packages/viewer/` (Vite + React + TS strict). Include `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`. | `@coder` | new package | none |
| 3 | Implement `fs/directory-loader.ts` + tests. Includes the FS Access path; the fallback-input shim is a separate task. | `@coder` | `packages/viewer/src/fs/directory-loader.{ts,test.ts}` | 1, 2 |
| 4 | Implement `fs/fallback-input.ts` shim for Firefox / Safari. | `@coder` | `packages/viewer/src/fs/fallback-input.ts` | 3 |
| 5 | Implement `state/url-state.ts` and `state/filters.ts` + tests. | `@coder` | `packages/viewer/src/state/{url-state,filters}.{ts,test.ts}` | 2 |
| 6 | Implement `ClusterList` component + tests. | `@designer` | `packages/viewer/src/components/ClusterList/*` | 3, 5 |
| 7 | Implement `ClusterDetail` component (Overview + Raw tabs first; Occurrences + Static/context subsequently). | `@designer` | `packages/viewer/src/components/ClusterDetail/*` | 3, 5 |
| 8 | Implement `OccurrenceTimeline`, `Screenshot`, console / network panes. | `@designer` | `packages/viewer/src/components/{OccurrenceTimeline,Screenshot}/*` | 7 |
| 9 | Implement `FilterBar` + `SearchBox`. | `@designer` | `packages/viewer/src/components/{FilterBar,SearchBox}/*` | 5, 6 |
| 10 | Implement `live-tail/poll.ts` + tests. | `@coder` | `packages/viewer/src/live-tail/poll.{ts,test.ts}` | 3 |
| 11 | Implement `live-tail/mcp-stream.ts` + tests. (Stub if v0.30 isn't shipped — implementation lands when v0.30 does.) | `@coder` | `packages/viewer/src/live-tail/mcp-stream.{ts,test.ts}` | 3 |
| 12 | Implement `bughunter view` CLI subcommand + tests. | `@coder` | `packages/cli/src/cli/view.ts`, `packages/cli/src/cli/main.ts`, `packages/cli/tests/view.test.ts` | 2 (build artifact must exist) |
| 13 | Build pipeline: `packages/cli/build.mjs` post-build copies `packages/viewer/dist/` → `packages/cli/viewer-dist/`. Update `packages/cli/package.json` `files` to include it. | `@devops` | `packages/cli/build.mjs`, `packages/cli/package.json` | 2 |
| 14 | Bundle-size CI gate. | `@devops` | `packages/viewer/scripts/check-bundle-size.mjs`, CI config | 2 |
| 15 | Smoke test on `vite-crawl-app` fixture; capture screenshot of all four UI states (idle, loading, loaded, error). | `@qa` | manual | 6-12 |
| 16 | Document `bughunter view` in README and the comprehensive spec (§8.6 follow-up note). | `@architect` | `README.md`, `SPEC_PATH_TO_EXHAUSTIVE.md` | 12, 15 |

Each task touches at most three files (modulo Task 2 which is the initial scaffold). All tasks except 6/7/8 are independently testable.

---

## 14. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| `npx tsc --noEmit` clean across `packages/viewer` and `packages/cli` | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| `npx vitest run` clean in `packages/viewer` | `vitest` |
| `npm run build` succeeds in `packages/viewer`; gzipped bundle ≤ 250KB | bundle-size CI gate |
| `bughunter view --no-open --port 8765` starts a server, `curl http://127.0.0.1:8765/` returns 200 | shell |
| Path-traversal request returns 400 | `curl http://127.0.0.1:8765/../etc/passwd` |
| Server binds only to 127.0.0.1 | `ss -lntp | grep 8765` shows `127.0.0.1:8765`, not `0.0.0.0:8765` |
| Manual: opening `vite-crawl-app/.bughunter/runs/<latest>/` shows clusters matching `summary.bugs_filed` | manual smoke |
| Manual: filter by `kind=console_error` narrows the list | manual smoke |
| Manual: search for a substring of a known `rootCause` selects the matching cluster | manual smoke |
| Manual: opening a cluster renders screenshot + action timeline + console errors | manual smoke |
| Manual: starting `bughunter run` in a separate terminal causes the viewer to show new clusters within 2s | manual smoke (live-tail poll path) |
| `summary.viewerVersion` is populated on every new run | `jq '.viewerVersion' summary.json` |
| Bundled CLI tarball includes `viewer-dist/` | `npm pack --dry-run \| grep viewer-dist` |
| Existing CLI subcommands (`run`, `list`, `inspect`, `prune`, `replay`) unchanged in behaviour | regression run |

---

## 15. Files

### 15.1 Files to create

```
packages/viewer/package.json
packages/viewer/tsconfig.json
packages/viewer/vite.config.ts
packages/viewer/index.html
packages/viewer/src/main.tsx
packages/viewer/src/App.tsx
packages/viewer/src/types.ts
packages/viewer/src/fs/directory-loader.ts
packages/viewer/src/fs/directory-loader.test.ts
packages/viewer/src/fs/fallback-input.ts
packages/viewer/src/state/url-state.ts
packages/viewer/src/state/url-state.test.ts
packages/viewer/src/state/filters.ts
packages/viewer/src/state/filters.test.ts
packages/viewer/src/components/ClusterList/{ClusterList.tsx,ClusterList.module.css,ClusterList.test.tsx}
packages/viewer/src/components/ClusterDetail/{ClusterDetail.tsx,ClusterDetail.module.css,ClusterDetail.test.tsx}
packages/viewer/src/components/OccurrenceTimeline/{OccurrenceTimeline.tsx,OccurrenceTimeline.module.css}
packages/viewer/src/components/Screenshot/{Screenshot.tsx,Screenshot.module.css}
packages/viewer/src/components/FilterBar/{FilterBar.tsx,FilterBar.module.css}
packages/viewer/src/components/SearchBox/{SearchBox.tsx,SearchBox.module.css}
packages/viewer/src/components/EmptyState/{EmptyState.tsx,EmptyState.module.css}
packages/viewer/src/components/ErrorBoundary/ErrorBoundary.tsx
packages/viewer/src/components/LiveTailIndicator/{LiveTailIndicator.tsx,LiveTailIndicator.module.css}
packages/viewer/src/live-tail/poll.ts
packages/viewer/src/live-tail/poll.test.ts
packages/viewer/src/live-tail/mcp-stream.ts
packages/viewer/src/live-tail/mcp-stream.test.ts
packages/viewer/scripts/check-bundle-size.mjs
packages/cli/src/cli/view.ts
packages/cli/tests/view.test.ts
```

### 15.2 Files to modify

```
packages/cli/src/cli/main.ts          # register the new subcommand
packages/cli/src/types.ts             # add RunSummary.viewerVersion
packages/cli/src/phases/emit.ts       # populate viewerVersion at run-emit time
packages/cli/build.mjs (or new)       # post-build copy viewer dist
packages/cli/package.json             # add viewer-dist to files; add "view" subcommand to CLI help
README.md                             # document `bughunter view`
SPEC_PATH_TO_EXHAUSTIVE.md            # back-reference §8.6 to this spec
```

### 15.3 Files NOT to create

- No new types module — re-use `packages/cli/src/types.ts`.
- No new run-reading library — the viewer's loader is browser-only and self-contained.
- No new build tool config beyond Vite — no Rollup, Webpack, esbuild, Parcel.

---

## 16. Definition of Done

The feature ships when:

1. All 16 tasks are merged.
2. `bughunter view` works on Linux, macOS, and Windows (smoke-tested on each by `@qa`).
3. The viewer renders correctly on Chrome 120+, Edge 120+, and the fallback path renders correctly on Firefox 120+ and Safari 17+.
4. The bundle-size CI gate is green (≤ 250KB gzipped).
5. All 14 acceptance criteria in §14 pass.
6. The README has a one-paragraph "Web UI viewer" section linking to `bughunter view --help`.
7. `SPEC_PATH_TO_EXHAUSTIVE.md` §8.6 has a back-reference: "Implemented in v0.47 — see `SPEC_V47_WEB_UI_VIEWER.md`."
8. v0.30 ships either before v0.47 or alongside it — the live-tail MCP path can be a stub merge that's filled in when v0.30 lands. The FS-poll path must work standalone.

---

## 17. Risks + escape hatches

- **Risk: FS Access API is too restrictive on some Chromium builds (corporate-managed, kiosk).** Mitigation: the fallback-input path is fully functional except for live-tail. Document the limitation in the README. If the corporate-fleet case becomes common, v0.48 adds an opt-in HTTP companion that exposes a `/runs/<id>/*` read endpoint (loopback only).
- **Risk: Bundle size creeps over 250KB.** The CI gate fails the build before merge. If a real need exceeds the budget (e.g. a charting library for v0.49 history), raise the cap in a spec amendment with explicit justification — don't drift it silently.
- **Risk: Schema drift between viewer-bundled types and CLI-emitted JSONL.** Mitigation: `summary.viewerVersion` banner (cf. §9.3) plus the viewer's "Raw" tab always renders the JSON, so no field is ever truly hidden by stale types.
- **Risk: Live-tail polling causes UI churn on slow disks.** Mitigation: poll interval is 1500ms with backoff if `summary.json` reads exceed 200ms; `bugs.jsonl` is only re-streamed on `bugs_filed` change.
- **Risk: User opens a directory containing PII (auth screenshots, JWTs in console logs) and the viewer renders it in plain text.** This is by design — the viewer renders what BugHunter wrote. PII handling is BugHunter's responsibility upstream. Document the threat model: the viewer is a local read-only renderer; do not screen-share an open viewer to untrusted parties.
- **Escape hatch:** if all Chromium builds globally degrade FS Access (regulatory action, etc.), the fallback-input path is the universal substrate. The viewer keeps working with file-pickers; only live-tail is lost.

---

## 18. Killer-demo runbook

```bash
# 1. Build viewer + CLI.
cd /root/BugHunter && \
  npm install && \
  (cd packages/viewer && npm run build) && \
  (cd packages/cli && npm run build)

# 2. Run BugHunter against the existing fixture so we have a populated runs/ dir.
cd /root/BugHunter/fixtures/vite-crawl-app && \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 50 --budget 600000

# 3. Launch the viewer (locally — opens default browser).
cd /root/BugHunter/fixtures/vite-crawl-app && \
  node /root/BugHunter/packages/cli/dist/cli/main.js view --port 8765

# 4. In the browser:
#    - Click "Open run directory"
#    - Pick fixtures/vite-crawl-app/.bughunter/runs/<latest>/
#    - Verify cluster count matches summary.json
#    - Filter, search, drill into a cluster, view screenshot + timeline.

# 5. Live-tail demo: start a fresh run in a second terminal.
cd /root/BugHunter/fixtures/vite-crawl-app && \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 200 --budget 1200000 &

# 6. In the browser, "Open run directory" against the new runs/<id>/ as it's being written.
#    Verify clusters appear without page reload.
```

Expected: viewer opens in <2s, cluster list populates in <1s, live-tail shows new clusters within 2s.

---

## 19. Open questions

1. **Should the viewer be a separately versioned package (`@bughunter/viewer@*`) or strictly bundled with the CLI?** Spec defaults to bundled-only for v0.47 (single install path). Standalone publish is a v0.47.1 follow-up if hosted-deployment use cases materialize.
2. **Should the viewer support multiple run directories side-by-side (compare two runs)?** Out of scope for v0.47 — v0.49 (Phase D `diff`) is the natural home for cross-run UI. Document the constraint: v0.47 shows exactly one run at a time.
3. **Should we add a "download as HTML" export so users can email a single self-contained file to a non-technical reviewer?** Tempting but defers the "web UI" value — a self-contained HTML export is a static artifact pipeline, not a viewer. Defer to v0.48 as `bughunter export --format html` (sub-section 4.4 of the comprehensive spec).
4. **Should the SSE / live-tail path also support WebSocket as a fallback?** No — SSE is sufficient for a one-way stream and is simpler. v0.30 specs SSE; we follow.
5. **Should the viewer hint at fix actions (e.g. "Run /bughunt fix on this cluster")?** Read-only in v0.47. Action affordances arrive in v0.48 once the FS Access write handle is wired and the triage state file is editable.
6. **Should the viewer ship a dark mode?** Yes — `prefers-color-scheme: dark` honored automatically; manual toggle reflected in the URL (`?theme=dark`). CSS Modules with custom-property tokens make this cheap (~30 lines).
7. **Should we instrument the viewer for telemetry (page-load time, time-to-first-cluster-render)?** Not in v0.47. Local-first; no telemetry. If we later hosted a viewer, instrumentation gets specced separately.
8. **Should the static server expose `summary.json` of the run that launched it via `--run`, or should the viewer always go through FS Access?** Always through FS Access in v0.47. Exposing run files via the static server would defeat the "no backend" promise and re-introduce the trust problem.
