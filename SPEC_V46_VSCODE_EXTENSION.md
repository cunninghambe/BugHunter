# SPEC — v0.46 "VSCode extension `cunninghambe.bughunter`"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** v0.45 SARIF/CI gate, v0.44 cross-time history · **Sibling:** v0.47 JetBrains plugin (deferred), v0.48 TUI triage. **Phase:** G (context expansion, §9 of `SPEC_PATH_TO_EXHAUSTIVE.md`).

This spec defines the first IDE-side surface for BugHunter — a VSCode extension that *visualises* `.bughunter/runs/<latest>/bugs.jsonl` and provides one-keystroke escalation to `/bughunt fix` and the `bughunter` CLI. It is the §8.3 promise of `SPEC_PATH_TO_EXHAUSTIVE.md`: "thin client reading bugs.jsonl + action logs from `.bughunter/runs/<latest>/`." No state lives in the extension. No detection logic lives in the extension. Findings authored by the CLI must look identical whether the user reads them in `bugs.jsonl`, in the SARIF report, in Linear/GitHub via the §8.5 webhook, or as squiggles in VSCode.

The extension ships from a **separate repo** (`cunninghambe/vscode-bughunter`) so that VSCode marketplace's package size and signing constraints don't pollute the BugHunter monorepo. CLI changes that affect the artifacts the extension reads must remain backward-compatible with at least the previous minor version of the extension; the extension declares a minimum CLI artifact version it understands.

---

## 1. Objective

Ship a VSCode extension `cunninghambe.bughunter` that:

1. **Reads** `.bughunter/runs/<latest>/bugs.jsonl` for the active VSCode workspace folder.
2. **Renders** clusters as inline squiggles on `suspectedFiles[].line` via the standard `vscode.languages.createDiagnosticCollection` API.
3. **Reveals** an Occurrence Detail panel (screenshot, action log, root cause, repro command) on `Cmd+Click` of a squiggle.
4. **Triggers** `/bughunt fix` for the cluster on `Cmd+.` via a Code Action.
5. **Surfaces** total clusters + critical-severity count in the status bar.
6. **Groups** clusters in a Tree View (Activity Bar entry) by kind / role / route.
7. **Refreshes** automatically when a new run lands or the active run's `bugs.jsonl` changes on disk.
8. **Drives** the CLI from the Command Palette: `BugHunter: Run`, `BugHunter: Retest`, `BugHunter: Fix Cluster`, `BugHunter: Open Latest Run`.

The architecture is strictly thin-client. Every byte of state is sourced from `.bughunter/runs/`. The extension owns ephemeral UI state (which tree node is expanded, which panel is focused) and nothing else. There is no extension-side database, no IPC daemon, no background detection.

**In scope:**
- Diagnostic collection backed by `bugs.jsonl`
- Occurrence Detail webview (screenshot, action log, root cause, repro command)
- Status bar item (total clusters + critical count)
- Tree View grouped by kind / role / route, reset by Cmd-click
- File watcher (`fs.watch`) on `.bughunter/runs/<latest>/bugs.jsonl`
- Command Palette commands that shell out to `bughunter`
- Code Action provider that maps `Cmd+.` to `/bughunt fix --cluster <id>`
- Marketplace publishing pipeline (CI workflow, signing, version bump)
- Extension settings (CLI path, severity floor for squiggles, run-dir override)

**Out of scope (deferred):**
- JetBrains plugin (v0.47).
- Neovim LSP-style diagnostics (v0.48).
- Web-UI viewer (§8.6).
- Inline auto-fix preview (waiting for `/bughunt fix --dry-run` from v0.45 fix-loop refactor).
- BugHunter daemon mode / streaming MCP subscriptions (v0.49).
- Triage state mutation from the extension — the extension shows verdicts but cannot set them (defer to v0.48 TUI which writes `triage.jsonl`).
- Multi-root workspace support — v0.46 supports the *first* workspace folder only; document and surface the limitation.
- Editing `.bughunter/config.json` from inside VSCode (defer to v0.49 settings UI).

**Acceptance target on Aspectv3:**
With `bughunter run` having produced a recent run, after installing the extension and reloading VSCode at `/root/Aspectv3`:
- All clusters with at least one `suspectedFiles[].line` resolve to a squiggle on the correct file:line.
- Status bar shows `BugHunter: 17 clusters · 3 critical` (matches `summary.json.byKind` totals filtered by severity).
- Tree View renders the 17 clusters under the three groupings.
- `Cmd+Click` on a squiggle opens the Occurrence Detail panel; the screenshot path resolves and renders inline.
- `Cmd+.` on a squiggle shows a Code Action `BugHunter: Fix this cluster (<kind>)`; selecting it spawns the `/bughunt fix` workflow (via Claude Code if available, else the CLI's `bughunter fix-summary` round-trip — see §6).

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/types.ts` (lines 207-230, `BugCluster`) | The exact shape `bugs.jsonl` records take. The extension consumes this type. |
| `packages/cli/src/store/filesystem.ts` (`runPaths`) | The on-disk layout: `bugs.jsonl`, `screenshots/`, `action-logs/`, `summary.json`. The extension must NOT hardcode these paths — it imports the same types. |
| `packages/cli/src/cli/fix-summary.ts` | The output the extension parses to render verdicts. |
| `packages/cli/bughunt.md` | The skill prompt that `/bughunt fix` runs against. The extension's `Cmd+.` integration triggers this same skill via Claude Code's CLI surface. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §6.6 (severity calibration) | The severity field the extension maps to `DiagnosticSeverity`. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §8.3 | The product-level spec for IDE extensions. This V-spec is the implementation. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format reference; structure mirrored here. |

### 2.2 Patterns to follow

- **Schema sharing.** The extension imports `BugCluster`, `Occurrence`, `BugKind`, and the future `Severity` field from a published `@bughunter/types` npm package (BugHunter monorepo will publish this; if not yet published as of v0.46 start, vendor a minimal `types.ts` into the extension and add a sync-test that diffs it against the source-of-truth file in CI).
- **Diagnostic collection.** Use `vscode.languages.createDiagnosticCollection('bughunter')`. One collection for the whole extension; clear and rebuild on every file refresh.
- **Tree views.** Use `vscode.window.createTreeView('bughunterClusters', { treeDataProvider })`. Three providers (kind / role / route); switch via a "Group by" dropdown.
- **Webview for Occurrence Detail.** Use `vscode.window.createWebviewPanel('bughunterOccurrence', ...)` with `localResourceRoots` set to the run's `screenshots/` directory. Use `webview.asWebviewUri` for screenshot rendering — never inline base64.
- **CLI invocation.** Use `child_process.spawn` with `cwd` set to the workspace root and a configurable absolute path to the `bughunter` binary (default: PATH lookup). Stream stdout/stderr to an Output Channel.
- **File watching.** `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.bughunter/runs/*/bugs.jsonl'))` — globbed across all run directories so a new run is picked up the instant `bugs.jsonl` is written.
- **Settings.** Contributed via `package.json` `contributes.configuration`. All keys under the `bughunter.*` namespace.
- **Activation.** Activate on `onStartupFinished` AND on file presence (`workspaceContains:.bughunter/runs/`). Keeps idle cost near zero in non-BugHunter workspaces.

### 2.3 DO NOT

- Do **not** copy any detection or classification logic into the extension. Detection is the CLI's job. The extension is a viewer.
- Do **not** define `BugCluster` shape on the extension side; import from `@bughunter/types` (or vendor + sync-check).
- Do **not** write to `.bughunter/runs/`. Read-only access. The CLI / `/bughunt fix` skill owns mutations.
- Do **not** open external browsers for the Occurrence panel — render in a VSCode webview so users keep editor focus.
- Do **not** ship Node-side dependencies that bloat the VSIX above 5 MB. The marketplace caps installs and large bundles erode ratings.
- Do **not** call any BugHunter network MCP server. Phase G's IDE story is filesystem-first; MCP integration is v0.49+.
- Do **not** auto-run `bughunter run` on extension activation. Surface the command but require user invocation. Surprise CLI runs are a privacy / cost / disruption risk.
- Do **not** mark non-actionable findings (`thirdPartyOrGenerated: true`) as squiggles by default. Hide them behind a setting `bughunter.showThirdParty` (default false), per existing skill convention.

---

## 3. Extension architecture

### 3.1 Top-level module layout (in `cunninghambe/vscode-bughunter`)

```
src/
  extension.ts                  # activate / deactivate
  domain/
    cluster-loader.ts           # parse bugs.jsonl → BugCluster[]
    severity.ts                 # BugKind → Severity → DiagnosticSeverity mapping
    run-resolver.ts             # find latest run dir; watcher lifecycle
  diagnostics/
    diagnostic-builder.ts       # BugCluster → vscode.Diagnostic[]
    diagnostic-collection.ts    # the one collection; refresh API
  ui/
    status-bar.ts               # cluster count + critical count
    tree/
      cluster-tree-provider.ts  # base provider; takes a grouping strategy
      group-by-kind.ts
      group-by-role.ts
      group-by-route.ts
    occurrence-panel.ts         # webview wrapper
  commands/
    open-occurrence.ts
    fix-cluster.ts              # Cmd+. handler (Code Action)
    run-cli.ts                  # bughunter run / retest dispatcher
    open-latest-run.ts          # reveal .bughunter/runs/<latest>/ in explorer
  codeactions/
    fix-cluster-provider.ts     # CodeActionProvider impl
  cli/
    spawn.ts                    # bughunter binary invocation, output channel
    claude-code.ts              # /bughunt fix dispatch via `claude` CLI when available
  types/
    bug-cluster.ts              # vendored; sync-check in CI
package.json
README.md
```

### 3.2 Activation flow

1. On `onStartupFinished` or `workspaceContains:.bughunter/runs/`, activate.
2. `runResolver.resolveLatest()` reads `.bughunter/runs/`, picks the directory whose `summary.json.startedAt` is newest (fallback: lexicographic max). If none exist, exit activation gracefully — extension remains dormant; status bar shows "BugHunter: no runs yet" and the Tree View shows a single "No runs" node with an inline "Run BugHunter" button.
3. `clusterLoader.load(runDir)` parses every line of `bugs.jsonl` into `BugCluster[]`. Lines that fail JSON parse are logged to the Output Channel and skipped (do not abort load — partial runs may leave a half-written final line).
4. `diagnosticBuilder.build(clusters)` produces a `Map<vscode.Uri, vscode.Diagnostic[]>`.
5. `diagnosticCollection.set` applies the map atomically.
6. `statusBar.update(clusters)` renders count + critical count.
7. Tree View providers receive the cluster array; user picks the active grouping.
8. The file watcher subscribes; on `bugs.jsonl` change, repeat 3-7.

### 3.3 Run resolution

The "latest run" is determined by `summary.json.startedAt`. If `summary.json` is missing (active run still executing), fall back to the most recent `state.json.startedAt`. If neither exists, the run directory is skipped (treated as not-yet-started). Never assume directory mtime — directory mtime is unreliable on shared filesystems and during retest passes that mutate older run dirs.

A new run is selected the moment a `bugs.jsonl` appears with at least one entry under a never-seen run directory; the watcher fires, runResolver re-runs, and the diagnostic collection is rebuilt. There is no animation or notification — the squiggles just update. Add a discreet status-bar pulse animation (1s) on refresh for feedback. Log "Loaded run <id> with N clusters" to the Output Channel.

### 3.4 Memory and load constraints

- A run with 10k clusters is plausible (Phase E generative-fuzz can balloon counts). Stream the `bugs.jsonl` line-reader (`readline.createInterface` over a fs read stream); never `fs.readFileSync` the whole file.
- Cap diagnostics at 5000 per file (VSCode rate-limits beyond ~10k). Surface "N more clusters in <file> not shown" via the Tree View if the cap is hit.
- The Tree View renders lazily — `getChildren` is called per-expand; do not materialize all leaves up front.
- Index clusters by URI (`Map<string, BugCluster[]>`) on load so the Code Action provider returns in O(1) for a given file. Do NOT linearly scan `bugs.jsonl` per Cmd+. invocation; that's a 10k-line scan in the worst case which violates the §14 p95 target.
- Index clusters by id (`Map<string, BugCluster>`) so `bughunter.openOccurrence` lookup is O(1).
- Keep both indices in a single `RunSnapshot` value object that is replaced atomically on refresh — never partially mutate. Eliminates a class of race conditions where a Code Action runs against a half-rebuilt index.

### 3.5 ClusterLoader sketch

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { BugCluster } from '../types/bug-cluster';

export type RunSnapshot = {
  runId: string;
  runDir: string;
  clusters: BugCluster[];
  byUri: Map<string, BugCluster[]>;
  byId: Map<string, BugCluster>;
  loadedAt: number;
};

export async function loadRun(runDir: string, log: vscode.OutputChannel): Promise<RunSnapshot> {
  const bugsFile = path.join(runDir, 'bugs.jsonl');
  const clusters: BugCluster[] = [];
  const stream = createReadStream(bugsFile, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (line.trim() === '') continue;
    try {
      const c = JSON.parse(line) as BugCluster;
      if (typeof c.id === 'string' && typeof c.kind === 'string') clusters.push(c);
    } catch (err) {
      log.appendLine(`bugs.jsonl line ${lineNo} skipped: ${(err as Error).message}`);
    }
  }
  return { runId: path.basename(runDir), runDir, clusters, ...buildIndices(clusters), loadedAt: Date.now() };
}
```

The body of `buildIndices` walks each cluster's `suspectedFiles`, normalises the path against the workspace root, and pushes into `byUri`. Pure function; unit-tested with golden fixtures.

---

## 4. Diagnostic-collection lifecycle

### 4.1 BugCluster → Diagnostic mapping

For each cluster, for each entry in `suspectedFiles`:

```
const suspectedFile: { path: string; line?: number; reason?: string } = ...;
const uri = vscode.Uri.file(path.resolve(workspaceRoot, suspectedFile.path));
const range = suspectedFile.line != null
  ? new vscode.Range(suspectedFile.line - 1, 0, suspectedFile.line - 1, Number.MAX_SAFE_INTEGER)
  : new vscode.Range(0, 0, 0, 0); // whole-file fallback
const diag = new vscode.Diagnostic(range, formatMessage(cluster), severityToVsCode(cluster.severity));
diag.code = { value: cluster.kind, target: vscode.Uri.parse(`bughunter:cluster/${cluster.id}`) };
diag.source = 'BugHunter';
diag.tags = computeTags(cluster); // e.g. Unnecessary for thirdPartyOrGenerated
```

**Note on `suspectedFiles` shape:** as of v0.45 the type in `packages/cli/src/types.ts` is `string[]`. **V46 requires** that the CLI promote it to `SuspectedFile[]` with `{ path: string; line?: number; reason?: string }` so the extension has a line target. This is a small but cross-cutting CLI change tracked in §11 (open question 1) — without `line`, the extension can only render whole-file squiggles and the value drops sharply. **Spec dependency:** v0.46 ships in lock-step with a v0.45.x CLI patch that adds the line field; otherwise the extension is reduced to whole-file mode and we ship v0.46 with that limitation documented and a TODO for v0.46.1.

### 4.2 Severity mapping (depends on §6.6 of `SPEC_PATH_TO_EXHAUSTIVE.md`)

| BugHunter severity (Phase C) | VSCode `DiagnosticSeverity` |
|---|---|
| `critical` | `Error` |
| `major` | `Warning` |
| `minor` | `Information` |
| `info` | `Hint` |

If a cluster has no severity (pre-Phase-C bugs.jsonl), derive a severity from `kind` using a vendored copy of the future `KIND_SEVERITY` table from CLI side. This vendor table must be sync-checked against the CLI source in CI; drift produces a build failure.

The user can set `bughunter.severityFloor: "minor"` (default) to hide `info` from squiggles; tree-view always shows everything. `info` clusters render with `DiagnosticTag.Unnecessary` so they grey out instead of squiggle.

### 4.3 Refresh trigger semantics

- **`bugs.jsonl` changed** (any run): full reload of the *latest* run.
- **`summary.json` appeared in a newer run dir**: the watcher's "create" event triggers `runResolver.resolveLatest`, which switches the active run, clears the diagnostic collection for the old run, and rebuilds. No UX prompt; the change is expected workflow.
- **Workspace folder change**: deactivate the watcher, re-resolve. Multi-root: only the first folder is watched in v0.46.
- **Manual refresh**: command `bughunter.refresh` re-runs the load pipeline. Useful when artifacts are mutated externally (e.g., `git pull`).

### 4.4 Edge cases on diagnostic build

| EC | Behavior |
|---|---|
| `suspectedFiles` empty | Cluster appears in Tree View but no squiggle. Tree node prefixed `(no source)`. |
| File path doesn't resolve under workspace root | Skip with Output Channel warning; do not throw. Common when CLI ran on a different host with a different cwd. |
| File exists but `line` is past EOF | Clamp to last line. |
| Cluster has 100 occurrences across 50 files | Render once per unique `suspectedFile`, not per occurrence. The Occurrence panel handles drill-down. |
| `bugs.jsonl` line fails JSON parse | Skip line; log; continue. Never abort the whole load. |
| Run directory deleted while extension running | File watcher emits delete; clear the diagnostic collection for that run. If it was the latest, fall back to next-latest. |
| Path is absolute outside workspace root (e.g. `node_modules` or system path) | Skip; log. Never produce squiggles outside the workspace. |
| Path is symlinked into workspace | Resolve via `fs.realpath`; squiggle on the real file location. |
| Two clusters resolve to the same file:line | Both diagnostics rendered; VSCode stacks them in the hover. |
| Cluster's `verdict: 'verified_fixed'` | Render with `DiagnosticTag.Unnecessary` (greyed/struck-through) and `Information` severity regardless of original kind severity — visual hint that no further action is needed. The cluster remains in the diagnostic collection so verification fixers can be reverted. |
| Cluster's `verdict: 'verified_fixed_by_removal'` | Same as above; tooltip notes "removed in latest run". |

---

## 5. Tree View / panels

### 5.1 Tree View `bughunterClusters`

Activity Bar entry: BugHunter (custom SVG icon shipped in `media/`).

Three modes, switched via a context-menu / dropdown action contributed under `view/title`:

- **Group by kind** (default): Top-level nodes are `BugKind` strings (e.g. `network_5xx`); leaves are individual clusters labelled `<rootCause>` with a description showing `<role> · <page>`.
- **Group by role**: Top-level nodes are roles (`owner`, `viewer`, `anonymous`, ...); leaves as above with description `<kind> · <page>`.
- **Group by route**: Top-level nodes are normalized routes; leaves as above with description `<kind> · <role>`.

Each leaf's `command` is `bughunter.openOccurrence` with the cluster id as an argument. The first occurrence of the cluster is opened by default; subsequent occurrences are accessible via a "Next occurrence" action inside the Occurrence panel.

Top-level nodes show counts: `network_5xx (12)`. Severity is reflected via icon colour (red / yellow / blue / grey).

Empty-state: a single node "No clusters in latest run · Run BugHunter" — clicking it invokes `bughunter.run`.

### 5.2 Occurrence Detail webview panel

Triggered by:
- `Cmd+Click` on a squiggle (custom hover provider that injects a clickable command link).
- Selecting a Tree View leaf.
- The `bughunter.openOccurrence` Command Palette command (asks for cluster id).

Layout:

```
+--------------------------------------------------------------+
| <kind> · <severity badge> · cluster <id>                      |
+--------------------------------------------------------------+
| Root cause: <rootCause>                                       |
| First seen: <firstSeenAt>   Last seen: <lastSeenAt>           |
| Occurrences: 4 / 4    [Prev]  [Next]                          |
+--------------------------------------------------------------+
| [Screenshot — scaled to fit; click → open original]           |
+--------------------------------------------------------------+
| Action log (collapsed; expand to see ordered actions)         |
| - navigate /admin                                             |
| - click [data-testid="user-row-0"]                            |
| - submit form#user-edit { name: "<xss>" }                     |
+--------------------------------------------------------------+
| Repro command:  bughunter replay <runId> <occurrenceId>       |
| [Copy]  [Run in terminal]                                     |
+--------------------------------------------------------------+
| Suspected files                                               |
| - src/admin/users.tsx:42 (referenced in stack)                |
| - src/api/users.ts:118  (referenced in network log)           |
+--------------------------------------------------------------+
| [Fix this cluster — opens /bughunt fix]                       |
+--------------------------------------------------------------+
```

The screenshot is loaded via `webview.asWebviewUri(vscode.Uri.file(occurrence.screenshotPath))`. Console errors and network requests in `OccurrenceFull` render below the action log in collapsible sections. For `OccurrenceSummary` (light mode), the panel shows a "Full artifacts not captured" banner and only the rootCause / replay command.

### 5.3 Status bar

Single status-bar item, alignment Right, priority 100 (sits left of git/branch widgets):

```
$(bug) BugHunter: 17 · 3!     ← 3 critical out of 17 clusters
```

Tooltip: full breakdown by severity. Click action: `bughunter.openLatestRun` (opens run dir in VSCode explorer + reveals `summary.json`). When no clusters exist: `$(bug) BugHunter: clean ✓`. When no run yet: `$(bug) BugHunter: not run`. The exclamation suffix is omitted when critical count is zero.

### 5.4 Hover provider for squiggle annotations

Standard VSCode hover (no custom provider needed for diagnostic content) — the diagnostic message itself includes the `code` link to `bughunter:cluster/<id>` which renders as a clickable link. Clicking opens the Occurrence panel. The `Cmd+Click` on a squiggle in v0.46 means clicking that link inside the hover popup, NOT a Cmd+Click on the squiggle highlight itself (VSCode does not natively expose "Cmd+Click on diagnostic"). Document this clearly in the README; consider in v0.47 a custom hover provider that surfaces the link more obviously.

---

## 6. `Cmd+.` integration with `/bughunt fix`

VSCode's `Cmd+.` (Quick Fix) is wired through the **Code Action** API. The extension registers a `CodeActionProvider` for any `vscode.DiagnosticCollection` source `BugHunter` (i.e., our diagnostics), producing one Code Action per cluster covered by the cursor's range/selection.

### 6.1 CodeAction shape

```ts
const action = new vscode.CodeAction(
  `BugHunter: Fix cluster ${cluster.id} (${cluster.kind})`,
  vscode.CodeActionKind.QuickFix,
);
action.diagnostics = [diagnostic];     // ties the action to that diagnostic
action.command = {
  command: 'bughunter.fixCluster',
  title: 'Fix cluster',
  arguments: [cluster.id, cluster.runId],
};
action.isPreferred = cluster.severity === 'critical';  // surfaces it at the top
```

### 6.2 Dispatch path

`bughunter.fixCluster(clusterId, runId)` resolves which channel to dispatch on, in order of preference:

1. **Claude Code is installed** (`claude --version` exits 0). Spawn `claude -p "/bughunt fix --cluster <id> --run <runId>"` with cwd = workspace root, stream output to the BugHunter Output Channel, and surface progress in the status bar (`$(sync~spin) BugHunter: fixing cluster <id>...`). On completion, run `bughunter fix-summary <runId>` and refresh the diagnostic collection so verdicts update.
2. **Fallback: CLI-only path**. Spawn `bughunter fix-summary <runId>` to render the current verdict table to the Output Channel and prompt the user with a notification ("Claude Code not installed — install it to enable in-IDE fix? [Install] [Open docs]"). Do not silently no-op.
3. **Failure**: surface a clear error toast ("BugHunter CLI not found at <path>; configure `bughunter.cliPath` setting"). Never throw an unhandled rejection.

### 6.3 What the spawned `/bughunt fix` does

The skill (already shipped, see `dist-skill/bughunt-host.md`) reads the cluster, drafts a fix, applies it via Claude Code's edit tooling, and writes the verdict back into `.bughunter/runs/<runId>/fix-state.json`. The extension does NOT need to know the internal flow — it only needs to:
- Spawn the dispatcher.
- Stream output for visibility.
- Watch for `fix-state.json` writes and re-render verdict badges in the Tree View.

Because all state writes happen on disk, the extension is stateless across the full fix loop — restart VSCode mid-fix and the next launch resumes correctly via filesystem watchers.

### 6.4 Concurrency and locking

Two simultaneous Code Action invocations on the same cluster are deduped by an in-extension `Set<string>` of in-flight cluster ids. The CLI itself uses file-locking on `fix-state.json` (existing v0.39 behavior); the extension trusts that and surfaces a "Already fixing this cluster" notification on duplicate dispatch.

### 6.5 Cancellation

Provide a status bar item `$(stop-circle) BugHunter: stop fix` while a fix is running. Clicking sends SIGTERM to the spawned Claude/CLI process; the extension does not roll back partial edits (the skill's contract is "leave the workspace in a sensible state" — out-of-scope to verify here).

### 6.6 Edge cases

| EC | Behavior |
|---|---|
| User triggers `Cmd+.` on a line where two clusters overlap | Both Code Actions are offered. User picks. Each runs independently. |
| Claude Code installed but unauthenticated | Spawn fails with non-zero exit; surface "Run `claude /login` and retry". |
| CLI prompts interactively (it shouldn't) | Detected by 30s no-output timeout → cancel → notify user. |
| Network outage mid-fix | Claude CLI handles retries; extension only times out after `bughunter.fixTimeoutMs` (default 600_000). |
| User edits a file mid-fix | Out-of-scope; the skill detects this and surfaces it in `fix-state.json`. |
| Cluster has `verdict: 'verified_fixed'` already | Code Action label changes to "BugHunter: Re-verify cluster ..." and dispatch runs `bughunter retest --cluster <id>` instead of fix. |
| Cluster has `verdict: 'architect_refused'` | Code Action is suppressed — the architect refused on quality grounds; surfacing the action invites users to override that decision unintentionally. The Tree View still shows the cluster with the refusal reason. |
| `thirdPartyOrGenerated: true` and `bughunter.showThirdParty: false` | No squiggle, hence no Code Action. Setting can be flipped per-workspace to override. |

### 6.7 Why Code Action and not a custom keybinding?

We deliberately wire `Cmd+.` through the standard `CodeActionProvider` rather than a custom keybinding (e.g. `bughunter.fixCluster` bound to `Cmd+.` directly). Reasons:
- Standard surface: any user familiar with VSCode quick-fix expects `Cmd+.` to open the lightbulb menu; a custom keybinding clobbering that on BugHunter clusters violates the principle of least surprise.
- Multi-action support: a single line can have multiple diagnostics from multiple sources (BugHunter + ESLint + TypeScript). The Code Action provider model lets all of them coexist; users see a unified menu.
- Future extensibility: we can add follow-up actions (e.g. "Suppress this cluster", "Open in Linear") without inventing more keybindings.

---

## 7. Marketplace publishing

### 7.1 Publisher account

- VSCode Marketplace publisher: `cunninghambe` (existing).
- Open VSX publisher: `cunninghambe` (mirror; extension MUST be listed on Open VSX too — VSCodium / Cursor / Theia users need it).
- Display name: `BugHunter`. Internal id: `cunninghambe.bughunter`.

### 7.2 package.json contributes

Key contributions:
- `commands`: `bughunter.run`, `bughunter.retest`, `bughunter.refresh`, `bughunter.openOccurrence`, `bughunter.fixCluster`, `bughunter.openLatestRun`, `bughunter.groupByKind`, `bughunter.groupByRole`, `bughunter.groupByRoute`.
- `views`: `bughunterClusters` under custom container `bughunter` in the Activity Bar.
- `viewsContainers.activitybar`: one entry, custom SVG icon.
- `configuration`: settings under `bughunter.*` (see §7.4).
- `menus`: `view/title` for grouping switcher; `view/item/context` for "Open occurrence", "Copy cluster id", "Fix this cluster".
- `activationEvents`: `onStartupFinished`, `workspaceContains:.bughunter/runs/`.
- `engines.vscode`: `^1.85.0` (December 2023; widely deployed).

### 7.3 CI / release pipeline

In `cunninghambe/vscode-bughunter`'s `.github/workflows/`:

- `ci.yml`: runs `npm run lint && npm run test && npm run package` on every PR. Verifies the type-vendoring sync-check.
- `release.yml`: triggered on tag push (`v*`). Publishes to both VSCode Marketplace (`vsce publish`) and Open VSX (`ovsx publish`). Uses encrypted PATs in repo secrets.
- `nightly.yml`: builds a `-pre-release` VSIX every night when main has new commits; publishes to a `pre-release` channel users can opt into.

Release cadence: monthly stable, weekly pre-release. Stable releases require all open issues tagged `release-blocker` to be closed.

### 7.4 Settings

| Setting key | Type | Default | Description |
|---|---|---|---|
| `bughunter.cliPath` | string | `bughunter` | Absolute path or PATH binary name. |
| `bughunter.severityFloor` | enum | `minor` | Hide clusters below this severity from squiggles. |
| `bughunter.showThirdParty` | boolean | `false` | Show clusters with `thirdPartyOrGenerated: true`. |
| `bughunter.runDirOverride` | string | `""` | Override the `.bughunter/runs/` root (rare; CI cache scenarios). |
| `bughunter.activeGrouping` | enum | `kind` | Tree View grouping: `kind` / `role` / `route`. |
| `bughunter.fixTimeoutMs` | number | `600000` | Max wait for a fix dispatch to complete. |
| `bughunter.runFlags` | string | `""` | Extra flags appended to `bughunter run` from the palette. |

### 7.5 Marketplace listing copy

```
BugHunter for VSCode
The first IDE surface for the BugHunter exhaustive bug-walker.
Inline squiggles for findings · Cmd+. to fix · Tree view by kind/role/route ·
One-click run from the palette.
Reads `.bughunter/runs/<latest>/bugs.jsonl` from your workspace —
no daemon, no telemetry, no cloud.
```

Screenshots required for marketplace approval: status bar, tree view (grouped by kind), squiggle on a real file, Occurrence panel showing screenshot + action log, Cmd+. menu showing the fix Code Action. README mirrors the `cunninghambe/BugHunter` repo's section on extensions.

### 7.6 Telemetry

**None.** Zero. The extension does not call out to any network endpoint owned by us. Reading `bugs.jsonl` is local. Spawning `bughunter` is local. Spawning `claude` is local. The README states this explicitly. (This is a competitive differentiator vs Sourcegraph / SonarLint / similar.)

---

## 7.7 Versioning + compatibility

- The extension's `package.json` `engines.vscode` minimum is `^1.85.0` — sets a 16-month back-compat window at launch (Dec 2023).
- The extension declares a `bughunter.minimumCliArtifactVersion` constant (initially `0`). When the CLI bumps a breaking artifact-format version (e.g. `bugs.jsonl` schema breaks), the extension reads `summary.json.artifactVersion` and falls back to a "Run BugHunter not compatible with this extension version — update extension or downgrade CLI" UX.
- SemVer for the extension itself: minor for new features, patch for fixes, major for breaking config changes (renamed setting keys, removed commands). Pre-Phase-D the extension is in `0.x` and any breaking change is allowed; document in CHANGELOG.

---

## 8. CLI parity

The Command Palette exposes the most-used CLI ops. Every Command-Palette command MUST be a thin wrapper over the existing CLI — no logic re-implementation.

| Palette command | Spawns |
|---|---|
| `BugHunter: Run` | `bughunter run [bughunter.runFlags]` |
| `BugHunter: Run (scoped to current file's route)` | `bughunter run --route <inferredRoute>` (best-effort; falls back to plain `run` if route can't be inferred) |
| `BugHunter: Retest cluster` | quick-pick of clusters → `bughunter retest --cluster <id> <runId>` |
| `BugHunter: Fix cluster` | quick-pick → same path as the Code Action (§6) |
| `BugHunter: Open latest run` | reveals `.bughunter/runs/<latest>/` in Explorer; opens `summary.json` |
| `BugHunter: Open run by id` | quick-pick of all runs → opens that run dir |
| `BugHunter: Refresh` | re-runs the load pipeline |
| `BugHunter: Open inspect for cluster` | `bughunter inspect <runId> <clusterId>` → renders output to Output Channel |

Output for every CLI invocation goes to the BugHunter Output Channel (`vscode.window.createOutputChannel('BugHunter')`). Errors surface as Notifications.

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| `BugCluster` type vendored matches CLI source | CI sync-check: `diff src/types/bug-cluster.ts <(curl raw.githubusercontent.com/.../packages/cli/src/types.ts)` returns expected subset; fails on drift |
| Extension activates on workspace with `.bughunter/runs/` and renders ≥1 squiggle in Aspectv3 | Manual: open `/root/Aspectv3` in VSCode; expect squiggles on suspected files |
| Status bar matches `summary.json.byKind` totals filtered by severity | Manual: cross-reference status-bar number with `jq '[.byKind | to_entries[] | .value] | add' summary.json` |
| Tree View enumerates every cluster in the latest run | Manual: leaf count == `wc -l bugs.jsonl` |
| `Cmd+.` on a squiggle exposes "BugHunter: Fix cluster" Code Action | Manual: position cursor on a suspectedFile line, hit Cmd+. |
| Fix dispatch via Claude Code path works end-to-end | Manual: trigger fix; verify `fix-state.json` updated; verdict badge appears in Tree View |
| Fallback path (Claude not installed) surfaces install notification | Manual: `mv $(which claude) /tmp/`, retry fix |
| Webview screenshot renders for an Occurrence with `screenshotPath` set | Manual: open occurrence panel for a `console_error` cluster |
| File watcher rebuilds collection on `bugs.jsonl` rewrite | Manual: append a fake cluster to `bugs.jsonl`; observe new squiggle within 1s |
| 5000-cluster cap honored without VSCode hang | Synthetic: write 6000 fake clusters; measure activation time < 3s |
| VSIX size ≤ 5 MB | `vsce package` output size |
| `npx tsc --noEmit` clean in extension repo | TS check |
| `npx eslint . --max-warnings 0` clean | Lint |
| Extension unit tests pass (`npm test`) | Vitest |
| Marketplace listing renders correctly (manual approval check before public publish) | Manual via marketplace preview |

---

## 10. Files

### 10.1 Files to create (in `cunninghambe/vscode-bughunter`)

| Path | Purpose |
|---|---|
| `src/extension.ts` | activation entry |
| `src/domain/cluster-loader.ts` | streamed JSONL parser |
| `src/domain/severity.ts` | severity → DiagnosticSeverity map |
| `src/domain/run-resolver.ts` | latest-run picker + watcher |
| `src/diagnostics/diagnostic-builder.ts` | cluster → Diagnostic[] |
| `src/diagnostics/diagnostic-collection.ts` | collection wrapper |
| `src/ui/status-bar.ts` | status-bar item |
| `src/ui/tree/cluster-tree-provider.ts` | TreeDataProvider base |
| `src/ui/tree/group-by-{kind,role,route}.ts` | grouping strategies |
| `src/ui/occurrence-panel.ts` | webview wrapper + HTML template |
| `src/commands/{open-occurrence,fix-cluster,run-cli,open-latest-run}.ts` | Command Palette handlers |
| `src/codeactions/fix-cluster-provider.ts` | Code Action provider |
| `src/cli/{spawn,claude-code}.ts` | child-process wrappers |
| `src/types/bug-cluster.ts` | vendored types + sync-check banner |
| `package.json` | manifest; `contributes` block |
| `README.md` | marketplace listing source-of-truth |
| `CHANGELOG.md` | required by marketplace |
| `media/icon.svg`, `media/icon-128.png` | activity-bar + listing icons |
| `.vscode/launch.json` | extension dev host config |
| `.github/workflows/{ci,release,nightly}.yml` | CI |
| `tests/cluster-loader.test.ts` | unit tests for JSONL parsing |
| `tests/severity.test.ts` | severity map round-trip |
| `tests/diagnostic-builder.test.ts` | golden cluster → expected Diagnostic[] |

### 10.2 Files to modify in BugHunter monorepo

| Path | Change |
|---|---|
| `packages/cli/src/types.ts` | (Pre-req) Promote `BugCluster.suspectedFiles` from `string[]` to `SuspectedFile[]`. Backward-compat read path tolerates either shape; write path always emits the new shape. |
| `packages/cli/src/cluster/index.ts` (or wherever clusters are minted) | Populate `line` from existing stack-trace / static-context fields when available. |
| `packages/cli/package.json` | Add `@bughunter/types` workspace package or otherwise expose `BugCluster` for the extension to consume / vendor. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §8.3 | Add cross-reference to this V46 spec. |
| `README.md` | Add "VSCode extension" section pointing to marketplace listing. |

### 10.3 Files NOT to modify

- `dist-skill/bughunt-host.md` — the skill prompt is the contract; the extension drives it but does not own it.
- Any detection / classification code under `packages/cli/src/{detectors,classify,security,perf}` — extension is consumer-only.

---

## 11. Open questions

1. **`SuspectedFile.line` — required pre-req or optional?** If we ship without `line`, squiggles are whole-file and the extension's value drops sharply. Recommendation: bundle the CLI patch as a v0.45.x release that lands the same week as the extension's first beta. Block stable extension release on the CLI patch being in a published BugHunter version.

2. **Publish `@bughunter/types` as a real package, or vendor + sync-check?** Real package is cleaner long-term but adds publish burden. Vendor + CI sync-check is enough for v0.46. Promote to real package at v0.47 when JetBrains plugin needs the same types.

3. **`Cmd+Click` on a squiggle — can we wire it as a *direct* click rather than via the hover popup link?** VSCode does not natively expose "click on diagnostic squiggle" as an event. Workaround: register a `vscode.commands.registerCommand` URI handler and surface it via the hover. If accepted UX is "click the link in the hover", document; if we must have direct click, file a VSCode upstream issue.

4. **Multi-root workspaces.** v0.46 supports first folder only. Should we surface a folder-picker widget (status-bar dropdown)? Defer to v0.47; document the v0.46 limitation in README.

5. **Pre-release channel ergonomics.** VSCode Marketplace's pre-release toggle is per-extension. Should we ship daily builds, or only on-demand betas for risk-tolerant users? Lean on-demand betas via `release.yml` manual trigger to limit churn.

6. **MCP integration.** Phase G is filesystem-first by design, but a future v0.49 could replace the file watcher with an MCP resource subscription, enabling cross-host scenarios (developer's IDE, BugHunter running on a CI box). Out of scope for v0.46; informs the architectural boundary (keep filesystem and MCP behind a `RunSource` interface from day one).

7. **Severity field availability.** Phase C defines per-kind severity; is it landing before or after v0.46 ships? If after, the extension uses a vendored fallback `KIND_SEVERITY` table and updates when Phase C lands. Recommend: ship v0.46 with the fallback; remove the fallback in v0.46.x once Phase C is in.

8. **Telemetry policy.** Should we offer *opt-in* anonymous usage stats (commands invoked, fix dispatch success rate)? Strong recommendation: NO. Zero telemetry is a competitive differentiator; start there and never add. If product analytics are needed later, derive them from the BugHunter CLI's existing run telemetry, not from the IDE surface.

9. **Webview content security.** The Occurrence panel renders HTML built from cluster data. CSP must forbid inline scripts; screenshots resolve via `webview.asWebviewUri`. Treat all string fields (rootCause, action.input) as untrusted — escape on render. Do not use `innerHTML` anywhere in the panel template.

10. **Extension API surface.** Should we expose a `vscode.bughunter.*` extension API that other extensions can call (e.g. a CodeQL extension subscribing to BugHunter clusters)? Out of scope for v0.46. If demand surfaces, design in v0.47 with a minimal stable contract: `getClusters(): BugCluster[]`, `onDidChangeClusters: Event<void>`.

---

## 12. Risks + escape hatches

- **Risk: `suspectedFiles[].line` accuracy is poor.** If the CLI fills `line` with stack-frame line numbers that point to compiled bundles rather than source files, squiggles land in `dist/` files no user opens. Mitigation: the CLI's source-mapping pass (existing for stack normalisation) must run before clusters are minted; add a unit test that asserts every emitted `line` resolves to a non-`node_modules`, non-`dist/` path under workspace root for the Aspectv3 fixture.
- **Risk: marketplace rejection.** First-time publishers face listing reviews. Mitigation: have the README, screenshots, and CHANGELOG ready before submission; publish first to Open VSX (frictionless) to gather feedback; submit to VSCode Marketplace once polish is verified.
- **Risk: extension activation on every workspace.** `onStartupFinished` activates broadly. Mitigation: gate the heavy work (file watcher, tree view) behind a `workspaceContains:.bughunter/runs/` check; activation overhead in non-BugHunter workspaces is the cost of `extension.ts` parsing only.
- **Risk: file watcher overhead on monorepos.** Watchers on `.bughunter/runs/*/bugs.jsonl` can produce noise. Mitigation: debounce reload by 500ms; coalesce burst events.
- **Escape hatch: disable the extension per-workspace.** Standard VSCode "Disable (Workspace)" command. The extension itself adds no escape hatches beyond what VSCode provides — this is the right level of control.

---

## 13. DoD

- [ ] All §10.1 files created in `cunninghambe/vscode-bughunter`.
- [ ] CI green on the extension repo (`ci.yml` passes, sync-check passes).
- [ ] §10.2 BugHunter monorepo changes merged in a coordinated PR (or deferred with a v0.46 limitations note in the README).
- [ ] Manual acceptance per §9 verified on `/root/Aspectv3`.
- [ ] Pre-release VSIX published to Open VSX.
- [ ] Marketplace listing approved by VSCode Marketplace (manual review).
- [ ] README in `cunninghambe/BugHunter` cross-links the marketplace listing.
- [ ] CHANGELOG entry "v0.46: VSCode extension" in BugHunter monorepo.
- [ ] Screencast demo (60s) posted to BugHunter docs site showing: open Aspectv3 → squiggles appear → Cmd+. → fix runs → squiggle clears.

---

## 14. Out-of-band reviewer checklist

When `@architect` reviews `@coder`'s implementation:

- Confirm zero detection logic in the extension repo (grep for `detect`, `classify`, `cluster` outside the data-shape parser).
- Confirm `BugCluster` type vendored from CLI source-of-truth, with sync-check workflow active.
- Confirm zero network calls to anything other than `localhost` `bughunter` / `claude` spawned children (`grep -r 'fetch\|http\.request\|https\.request'` in the extension src).
- Confirm zero writes to `.bughunter/runs/` from the extension (`grep -r 'fs\.write\|writeFile\|appendFile'` in extension src outside of the Output Channel and webview build).
- Confirm activation overhead < 100ms in a workspace WITHOUT `.bughunter/runs/` (measured by VSCode's built-in extension profiler).
- Confirm Code Action provider returns within 50ms p95 (lazy resolution of cluster lookups; do NOT iterate the full bugs.jsonl on every Cmd+. invocation — index by URI on load).
- Confirm marketplace listing screenshots are not stale (regenerate every minor release).
