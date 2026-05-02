#!/usr/bin/env node
// BugHunter CLI entry point.

import { initCommand } from './init.js';
import type { InitOptions } from './init.js';
import { runCommand } from './run.js';
import { replayCommand } from './replay.js';
import { inspectCommand } from './inspect.js';
import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { pruneCommand } from './prune.js';
import { paletteCommand } from './palette.js';
import { forbiddenPathGateCommand } from './forbidden-path-gate.js';
import { retestCommand } from './retest-cmd.js';
import { fixSummaryCommand } from './fix-summary.js';
import { doctorCommand } from './doctor.js';
import { detectorsCommand } from './detectors-cmd.js';
import { scopeCommand } from './scope.js';
import { inputsCommand } from './inputs-cmd.js';
import { configCommand } from './config-cmd.js';
import { selfTestCommand } from './self-test.js';
import { diffCommand } from './diff.js';
import { historyCommand } from './history.js';
import { ingestCommand } from './ingest.js';
import { agingCommand } from './aging.js';
import { suppressCommand } from './suppress.js';
import { unsuppressCommand } from './unsuppress.js';
import { triageCliCommand } from './triage.js';
import { explainCliCommand } from './explain.js';
import { exportCommand, parseExportArgs } from './export.js';
import { coverageCommand } from './coverage.js';
import { ciCommand } from './ci.js';
import { publishCommand } from './publish.js';
import { bisectCommand } from './bisect/bisect-cmd.js';
import { runBisectStep } from './bisect/bisect-step.js';
import { calibrateCommand, CalibrateSetupError, CalibrateEnvironmentError, CalibrateGoldError, CalibrateRunError } from './calibrate.js';
import { notifyTestCommand } from './notify-test.js';
import { dataIntegrityCheckCommand } from './data-integrity-check.js';
import type { DetectorStatus } from '../detectors/registry.js';
import type { BugKind, PaletteVariant } from '../types.js';
import { log } from '../log.js';
import { parseSeed } from '../lib/rng.js';

const USAGE = `
BugHunter v0.1 — exhaustive UI + API bug hunting for local dev apps

Usage:
  bughunter init [--no-interactive] [--project-name <name>] [--surface-mcp-url <url>]
                 [--browser-mcp-url <url>] [--browser-transport <mcp-http|mcp-stdio|http-legacy>]
                 [--reset-command <cmd>] [--reset-policy <policy>]
  bughunter view [--port <n>] [--no-open] [--mcp <url>] [--run <runId>]
  bughunter run [options]
  bughunter replay <occurrenceId>
  bughunter inspect <occurrenceId|clusterId>
  bughunter list
  bughunter status <runId>
  bughunter palette
  bughunter prune
  bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]
  bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]
  bughunter fix-summary <runId>
  bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind=k|severity=s>]
  bughunter history [--kind <bugkind>] [--bug-identity <id>] [--limit <n>] [--format table|json]
  bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]
  bughunter aging [--threshold <days>] [--min-runs <n>]
  bughunter prune [--rebuild-identity] [--force]
  bughunter suppress <pattern> --reason <text> [--expires <iso>] [--cluster-id <id>]
  bughunter unsuppress <pattern>
  bughunter triage [--interactive] [--run-id <id>]
  bughunter explain <clusterId> [--no-cache] [--run-id <id>]
  bughunter bisect <bug-id> [--commit-range <a..b>] [--consensus <n>] [--threshold <m>]
                            [--strict] [--build-command <cmd>] [--app-command <cmd>]
                            [--resume] [--no-cleanup] [--format json|text] [--json-log]
                            [--quiet] [--no-build]
  bughunter export <runId> --format <sarif|github|gitlab|csv|linear|jira>
                           [--out <path>] [--severity-min <level>] [--truncate <n>] [--no-third-party]
  bughunter ci [run-options] [--runId <id>] [--fail-on <spec>]
               [--report <path>] [--summary-md <path>] [--diff-against <runId>] [--upload]
  bughunter publish <runId> --target github
                            [--ref <ref>] [--sha <sha>] [--report <path>]

Triage & suppression:
  Pattern grammar: bugIdentity:<exact> | kind:<BugKind> | endpoint:<glob> |
                   suspectedFile:<glob> | severity:<critical|major|minor|info>
  Reason is REQUIRED on suppress. Audit trail: .bughunter/suppressions-audit.log.
  Triage state: .bughunter/triage.jsonl. Explain cost cap: $0.50/cluster (~5c typical).

Run options:
  --route <pattern>           Limit to routes matching glob
  --role <name>               Limit to a single role
  --max-bugs <n>              Stop-and-emit at N clusters (default 200)
  --max-runtime <ms>          Run-level timeout (default 86400000 = 24h)
  --budget <ms>               Time-box the run
  --concurrency <n>           Browser concurrency (default 4)
  --api-concurrency <n>       API concurrency (default 16)
  --reset                     Run resetCommand before discovery
  --resume <runId>            Continue from saved state
  --force-resume              Resume even if SurfaceMCP revision differs
  --include-external          Allow external side-effect API calls
  --read-only                 Disable all mutating actions. No POST/PATCH/PUT/DELETE
                              against the target. Disables: race-conditions, pen-testing,
                              synthetic, auth-flow, auth-probe, XSS canaries, V42
                              data-integrity, V20 network-fault on mutating endpoints.
                              Narrows: cross-user IDOR to read-only replays.
                              Always-fire: SEO, a11y, perf vitals, vision, static analysis,
                              naturally-occurring 5xx/4xx, render-only visual anomalies.
                              Browser-login POST is the one sanctioned exception
                              (use --no-browser-login to suppress).
                              Recommended for staging audits. Env: BUGHUNTER_READ_ONLY=1.
                              Mutually exclusive with --reset.

Deterministic mode (v0.32):
  --seed <n>                  Seed (32-bit non-negative integer) for all id generation.
                              Stable cuid2 ids across runs. Partial determinism without
                              --frozen-clock (timestamps still wall-clock).
  --frozen-clock <iso8601>    Pin all emitted timestamps to this value (e.g.
                              2026-05-01T12:00:00.000Z). Does not affect budget math.
  --frozen-network <path>     Replay HTTP from a recorded HAR file. Hard-fail on miss
                              unless --allow-network-miss is set.
  --record-network <path>     Record outbound HTTP to a HAR file for later replay.
  --allow-network-miss        When --frozen-network, fall through to live network on miss
                              instead of failing. Voids the determinism contract.

i18n / locale stress:
  --locale-stress             Enable i18n locale-stress post-discovery phase (RTL, long strings,
                              ambiguous dates, currency format, pluralization, timezone).
                              Gated by vision budget; runs per-URL after discovery.

Accessibility / SEO:
  --a11y                      Enable accessibility_critical baseline + delta checks.
                              Delta runs axe pre/post each UI action; adds ~400ms/action.
  --a11y-strict               Enable a11y baseline + keyboard-trap + focus-lost (implies --a11y)
  --seo                       Enable SEO hygiene cluster
  --no-seo-duplicate-titles   Suppress seo_title_duplicate_across_routes detections
  --keyboard-trap-max <n>     Max Tab presses during keyboard trap probe (default 20)
  --form-reachability-timeout <ms>  Max wait for form to appear in probe/execute (default from config)

Browser-platform probe (v0.36):
  --browser-platform              Enable browser-platform probe (default: on)
  --no-browser-platform           Disable browser-platform probe
  --browser-platform-force-deny   Opt-in to forced-permission-deny path (changes browser state)
  --browser-platform-sw-stale-ms <ms>  Override SW staleness threshold (default 60000)

Performance / heap:
  --enable-perf               Enable web vitals + long task + heap sampling
  --enable-bundle-probe       Enable bundle size probe
  --enable-memory-profile     Enable heap-sample collection (subset of --enable-perf)
  --enable-all-v06            Shortcut for --enable-perf + --enable-bundle-probe + --enable-memory-profile
  --lcp-threshold <ms>        LCP slow threshold (default 2500)
  --inp-threshold <ms>        INP slow threshold (default 200)
  --cls-threshold <n>         CLS threshold (default 0.1)
  --n-plus-one-threshold <n>  N+1 request threshold (default 8)
  --bundle-js-budget <KB>     Initial JS budget gzipped (default 500)
  --bundle-css-budget <KB>    Initial CSS budget gzipped (default 200)
  --enable-heap-attribution   Enable heap diff retainer attribution (implies --enable-memory-profile)
  --no-heap-attribution       Disable heap attribution even if config has it on
  --heap-snapshot-frequency <auto|n>  Snapshot frequency (default 'auto')
  --heap-diff-min-instances <n>  Min instances for diff (default 10)
  --heap-diff-min-bytes <n>   Min bytes for diff (default 5000000)

Cross-run / regression / history:
  bughunter bisect <bug-id> [--commit-range <a..b>] [--consensus <n>] [--threshold <m>]
                            [--strict] [--build-command <cmd>] [--app-command <cmd>]
                            [--resume] [--no-cleanup] [--format json|text] [--json-log]
                            [--quiet] [--no-build]
                              Binary-search for the commit that introduced a bug.
                              <bug-id>: bugIdentity (16-hex), cluster id (cuid), or occurrenceId.
                              Requires bisect.appCommand in config (and bisect.buildCommand if
                              the project needs a build step).
  (see also: bughunter diff, bughunter history, bughunter aging)

Diagnostics & introspection:
  bughunter doctor [--format table|json]
                              Reports environment health.
                              Exit 0 = green, 1 = yellow, 2 = red.
  bughunter detectors [--kind <bugkind>] [--status wired|dead|deferred] [--format table|json]
                              Per-BugKind wiring report.
  bughunter scope [--route <pattern>] [--role <name>] [--format table|json]
                              Dry-run: print the test matrix 'bughunter run' would
                              generate. Runs validate + discover + plan; skips
                              execute. NEVER mutates state.
  bughunter inputs <toolId> [--palette null|happy|edge|out_of_bounds]
                              For one tool, print the test inputs the planner
                              would mint. Output: JSON list of {palette, input}.
                              Useful for debugging fuzz strategies.
  bughunter config validate
                              Run Zod against .bughunter/config.json + palette.json.
                              Prints multi-issue report on failure. Warns on orphan
                              fixtures. Exit 0 valid, 1 invalid.
  bughunter config show [--resolved]
                              Print effective config (--resolved applies defaults)
                              or raw file. JSON output. vision.apiKey is redacted.

Data integrity invariants (v0.42):
  --no-data-integrity         Disable data-integrity invariant evaluation (invariants still parse-validated).
  --data-integrity-only <name>
                              Only run the named invariant(s); pass multiple times.
  --data-integrity-explain    Emit per-action summary table to data-integrity-explain.txt.
  --data-integrity-dry-run    Parse and match invariants but do not execute queries.
  bughunter dataIntegrity check [--only <name>] [--format table|json]
                              Validate invariant config against known routes.

Diagnostics (self-test):
  bughunter self-test [--budget <ms>] [--max-bugs <n>] [--json] [--no-fail-on-flake]
                      [--keep-run] [--skip-fixture-up]
                              Runs BugHunter against fixtures/bughunter-self-deliberate-bugs/
                              and asserts every wired BugKind fires (and every deferred kind
                              stays absent) within the wallclock budget.
                              Exit 0 = all pass, 1 = miss/false-positive/budget, 2 = setup error.
                              Contributor tool only — must run from a BugHunter repo checkout.

Calibration:
  bughunter calibrate --app <path> [--gold <path>] [--out <path>]
                      [--enforce-thresholds] [--thresholds <path>]
                      [--record-identities] [--force] [--no-boot] [--json]
                              Runs BugHunter against a BugHunter-bench app directory,
                              matches emitted clusters to gold-standard.jsonl, and computes
                              per-kind precision/recall/F1. Emits calibration-report.json.
                              --enforce-thresholds: exit 1 on per-kind threshold violation.
                              --record-identities: rewrite gold-standard.jsonl with bugIdentity.
                              --no-boot: skip bootScript/healthCheck/teardownScript.
                              Exit codes: 0=pass, 1=threshold violation, 2=env error,
                                          3=gold authoring error, 4=run failure.

  Gold-standard format: JSONL, one object per line. Each entry: goldId, kind, expected,
  bugIdentity (optional), structuralMatch (required if no bugIdentity), rationale, humanRepro[],
  minClusterSize (optional), addedInBenchVersion.
`;

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const [, , command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = i + 1 < rest.length ? rest[i + 1] : undefined;
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { command, args, flags };
}

async function main(): Promise<void> {
  // Pass-through --help / -h before any other validation so init and other
  // commands that open stdin don't block on the readline prompt.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE  }\n`);
    return;
  }

  const { command, args, flags } = parseArgs(process.argv);
  const projectDir = process.cwd();

  try {
    switch (command) {
      case 'init': {
        const initOpts: InitOptions = {
          noInteractive: flags['no-interactive'] === true,
          projectName: typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined,
          surfaceMcpUrl: typeof flags['surface-mcp-url'] === 'string' ? flags['surface-mcp-url'] : undefined,
          browserMcpUrl: typeof flags['browser-mcp-url'] === 'string' ? flags['browser-mcp-url'] : undefined,
          browserTransport: typeof flags['browser-transport'] === 'string'
            ? (flags['browser-transport'] as InitOptions['browserTransport'])
            : undefined,
          resetCommand: typeof flags['reset-command'] === 'string' ? flags['reset-command'] : undefined,
          resetPolicy: typeof flags['reset-policy'] === 'string'
            ? (flags['reset-policy'] as InitOptions['resetPolicy'])
            : undefined,
        };
        await initCommand(projectDir, initOpts);
        break;
      }

      case 'run': {
        if (flags['auto-fix'] === true) {
          process.stdout.write(
            'Auto-fix is now invoked from a Claude Code session via the /bughunt fix skill. See SPEC § 3.9.\n',
          );
          return;
        }
        const enableAll = flags['enable-all-v06'] === true;
        await runCommand({
          projectDir,
          route: typeof flags['route'] === 'string' ? flags['route'] : undefined,
          role: typeof flags['role'] === 'string' ? flags['role'] : undefined,
          maxBugs: typeof flags['max-bugs'] === 'string' ? parseInt(flags['max-bugs'], 10) : undefined,
          maxRuntime: typeof flags['max-runtime'] === 'string' ? parseInt(flags['max-runtime'], 10) : undefined,
          budget: typeof flags['budget'] === 'string' ? parseInt(flags['budget'], 10) : undefined,
          concurrency: typeof flags['concurrency'] === 'string' ? parseInt(flags['concurrency'], 10) : undefined,
          apiConcurrency: typeof flags['api-concurrency'] === 'string' ? parseInt(flags['api-concurrency'], 10) : undefined,
          reset: flags['reset'] === true,
          resume: typeof flags['resume'] === 'string' ? flags['resume'] : undefined,
          forceResume: flags['force-resume'] === true,
          a11y: flags['a11y'] === true,
          includeExternal: flags['include-external'] === true,
          enablePerf: flags['enable-perf'] === true || enableAll,
          enableBundleProbe: flags['enable-bundle-probe'] === true || enableAll,
          enableMemoryProfile: flags['enable-memory-profile'] === true || enableAll,
          lcpThreshold: typeof flags['lcp-threshold'] === 'string' ? parseInt(flags['lcp-threshold'], 10) : undefined,
          inpThreshold: typeof flags['inp-threshold'] === 'string' ? parseInt(flags['inp-threshold'], 10) : undefined,
          clsThreshold: typeof flags['cls-threshold'] === 'string' ? parseFloat(flags['cls-threshold']) : undefined,
          nPlusOneThreshold: typeof flags['n-plus-one-threshold'] === 'string' ? parseInt(flags['n-plus-one-threshold'], 10) : undefined,
          bundleJsBudgetKb: typeof flags['bundle-js-budget'] === 'string' ? parseInt(flags['bundle-js-budget'], 10) : undefined,
          bundleCssBudgetKb: typeof flags['bundle-css-budget'] === 'string' ? parseInt(flags['bundle-css-budget'], 10) : undefined,
          a11yStrict: flags['a11y-strict'] === true,
          seoEnabled: flags['seo'] === true,
          noSeoDuplicateTitles: flags['no-seo-duplicate-titles'] === true,
          keyboardTrapMax: typeof flags['keyboard-trap-max'] === 'string' ? parseInt(flags['keyboard-trap-max'], 10) : undefined,
          formReachabilityTimeout: typeof flags['form-reachability-timeout'] === 'string' ? parseInt(flags['form-reachability-timeout'], 10) : undefined,
          enableHeapAttribution: flags['enable-heap-attribution'] === true,
          noHeapAttribution: flags['no-heap-attribution'] === true,
          heapSnapshotFrequency: typeof flags['heap-snapshot-frequency'] === 'string'
            ? (flags['heap-snapshot-frequency'] === 'auto' ? 'auto' : parseInt(flags['heap-snapshot-frequency'], 10))
            : undefined,
          heapDiffMinInstances: typeof flags['heap-diff-min-instances'] === 'string' ? parseInt(flags['heap-diff-min-instances'], 10) : undefined,
          heapDiffMinBytes: typeof flags['heap-diff-min-bytes'] === 'string' ? parseInt(flags['heap-diff-min-bytes'], 10) : undefined,
          // v0.19 race-condition flags
          raceConditions: flags['race-conditions'] === true,
          noRaceConditions: flags['no-race-conditions'] === true,
          raceVariants: typeof flags['race-variants'] === 'string' ? flags['race-variants'] : undefined,
          raceCrossTab: flags['race-cross-tab'] === true,
          raceStrict: flags['race-strict'] === true,
          enableNavState: flags['enable-nav-state'] === true,
          navStateRefreshRace: flags['nav-state-refresh-race'] === true,
          enableHistoryCorruption: flags['enable-history-corruption'] === true,
          navStateSkipRoute: typeof flags['nav-state-skip-route'] === 'string' ? flags['nav-state-skip-route'] : undefined,
          navStateDeepLinkMaxDepth: typeof flags['nav-state-deep-link-max-depth'] === 'string' ? parseInt(flags['nav-state-deep-link-max-depth'], 10) : undefined,
          idor: flags['idor'] === true,
          noIdor: flags['no-idor'] === true,
          // v0.32 deterministic mode flags
          seed: typeof flags['seed'] === 'string' ? parseSeed(flags['seed']) : undefined,
          // v0.39 fuzz flags
          fuzz: typeof flags['fuzz'] === 'string' ? flags['fuzz'] : undefined,
          fuzzStrategies: typeof flags['fuzz-strategies'] === 'string' ? flags['fuzz-strategies'] : undefined,
          fuzzRuns: typeof flags['fuzz-runs'] === 'string' ? parseInt(flags['fuzz-runs'], 10) : undefined,
          fuzzShrink: flags['fuzz-shrink'] === 'on' ? true : flags['fuzz-shrink'] === 'off' ? false : undefined,
          noFuzz: flags['no-fuzz'] === true,
          frozenClock: typeof flags['frozen-clock'] === 'string' ? flags['frozen-clock'] : undefined,
          frozenNetwork: typeof flags['frozen-network'] === 'string' ? flags['frozen-network'] : undefined,
          recordNetwork: typeof flags['record-network'] === 'string' ? flags['record-network'] : undefined,
          allowNetworkMiss: flags['allow-network-miss'] === true,
          // v0.45 read-only mode
          readOnly: flags['read-only'] === true,
          // v0.36 browser-platform flags
          browserPlatform: flags['browser-platform'] === true,
          noBrowserPlatform: flags['no-browser-platform'] === true,
          browserPlatformForceDeny: flags['browser-platform-force-deny'] === true,
          browserPlatformSwStaleMs: typeof flags['browser-platform-sw-stale-ms'] === 'string'
            ? parseInt(flags['browser-platform-sw-stale-ms'], 10)
            : undefined,
          localeStress: flags['locale-stress'] === true,
          // v0.38 interaction-palette flags
          interactionPalette: flags['interaction-palette'] === true,
          noInteractionPalette: flags['no-interaction-palette'] === true,
          interactionPaletteMax: typeof flags['interaction-palette-max'] === 'string' ? parseInt(flags['interaction-palette-max'], 10) : undefined,
          interactionVisionThreshold: typeof flags['interaction-vision-threshold'] === 'string' ? parseFloat(flags['interaction-vision-threshold']) : undefined,
        });
        break;
      }

      case 'replay': {
        const replayId = args[0] ?? '';
        if (replayId === '') throw new Error('Usage: bughunter replay <occurrenceId>');
        await replayCommand(projectDir, replayId);
        break;
      }

      case 'inspect': {
        const inspectId = args[0] ?? '';
        if (inspectId === '') throw new Error('Usage: bughunter inspect <occurrenceId|clusterId>');
        inspectCommand(projectDir, inspectId);
        break;
      }

      case 'coverage': {
        const coverageRunId = args[0];
        coverageCommand(projectDir, coverageRunId, {
          latest: flags['latest'] === true,
          json: flags['json'] === true,
          dead: flags['dead'] === true,
          kind: typeof flags['kind'] === 'string' ? flags['kind'] : undefined,
          verbose: flags['verbose'] === true,
        });
        break;
      }

      case 'list':
        listCommand(projectDir);
        break;

      case 'status': {
        const statusRunId = args[0] ?? '';
        if (statusRunId === '') throw new Error('Usage: bughunter status <runId>');
        statusCommand(projectDir, statusRunId);
        break;
      }

      case 'palette':
        paletteCommand(projectDir);
        break;

      case 'prune':
        pruneCommand(projectDir, {
          rebuildIdentity: flags['rebuild-identity'] === true,
          force: flags['force'] === true,
        });
        break;

      case 'forbidden-path-gate': {
        const branch = args[0] ?? '';
        if (branch === '') throw new Error('Usage: bughunter forbidden-path-gate <branch> [--base <baseBranch>] [--reset]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : 'main';
        const reset = flags['reset'] === true;
        forbiddenPathGateCommand(projectDir, branch, baseBranch, reset);
        break;
      }

      case 'retest': {
        const runId = args[0] ?? '';
        const clusterId = args[1] ?? '';
        if (runId === '' || clusterId === '') throw new Error('Usage: bughunter retest <runId> <clusterId> [--base <baseBranch>] [--branch <fixBranch>]');
        const baseBranch = typeof flags['base'] === 'string' ? flags['base'] : undefined;
        const fixBranch = typeof flags['branch'] === 'string' ? flags['branch'] : undefined;
        await retestCommand(projectDir, runId, clusterId, baseBranch, fixBranch);
        break;
      }

      case 'fix-summary': {
        const runId = args[0] ?? '';
        if (runId === '') throw new Error('Usage: bughunter fix-summary <runId>');
        fixSummaryCommand(projectDir, runId);
        break;
      }

      case 'doctor': {
        const format = flags['format'] === 'json' ? 'json' : 'table';
        await doctorCommand(projectDir, { format });
        break;
      }

      case 'detectors': {
        const kind = typeof flags['kind'] === 'string' ? flags['kind'] as BugKind : undefined;
        const statusFlag = flags['status'];
        const status = (statusFlag === 'wired' || statusFlag === 'dead' || statusFlag === 'deferred') ? statusFlag as DetectorStatus : undefined;
        const format = flags['format'] === 'json' ? 'json' : 'table';
        detectorsCommand(projectDir, { kind, status, format });
        break;
      }

      case 'scope': {
        await scopeCommand(projectDir, {
          route: typeof flags['route'] === 'string' ? flags['route'] : undefined,
          role: typeof flags['role'] === 'string' ? flags['role'] : undefined,
          format: flags['format'] === 'json' ? 'json' : 'table',
        });
        break;
      }

      case 'diff': {
        const runIdOld = args[0] ?? '';
        const runIdNew = args[1] ?? '';
        if (runIdOld === '' || runIdNew === '') {
          throw new Error('Usage: bughunter diff <runIdOld> <runIdNew> [--format table|json|sarif] [--filter <kind=k>]');
        }
        const diffFormat = typeof flags['format'] === 'string'
          ? (flags['format'] as 'table' | 'json' | 'sarif')
          : undefined;
        const filterRaw = typeof flags['filter'] === 'string' ? flags['filter'] : undefined;
        const filterKind = filterRaw?.startsWith('kind=') === true ? (filterRaw.slice(5) as BugKind) : undefined;
        diffCommand(projectDir, {
          runIdOld,
          runIdNew,
          format: diffFormat,
          filter: filterKind !== undefined ? { kind: filterKind } : undefined,
        });
        break;
      }

      case 'inputs': {
        const toolId = args[0] ?? '';
        if (toolId === '') throw new Error('Usage: bughunter inputs <toolId> [--palette <variant>]');
        const palette = typeof flags['palette'] === 'string' ? flags['palette'] as PaletteVariant : undefined;
        await inputsCommand(projectDir, toolId, { palette, format: 'json' });
        break;
      }

      case 'config': {
        const sub = args[0] ?? '';
        if (sub !== 'validate' && sub !== 'show') {
          throw new Error('Usage: bughunter config validate | show [--resolved]');
        }
        configCommand(projectDir, sub, { resolved: flags['resolved'] === true });
        break;
      }

      case 'history': {
        const historyFormat = typeof flags['format'] === 'string'
          ? (flags['format'] as 'table' | 'json')
          : undefined;
        historyCommand(projectDir, {
          kind: typeof flags['kind'] === 'string' ? (flags['kind'] as BugKind) : undefined,
          limit: typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : undefined,
          bugIdentity: typeof flags['bug-identity'] === 'string' ? flags['bug-identity'] : undefined,
          format: historyFormat,
        });
        break;
      }

      case 'suppress': {
        const pattern = args[0] ?? '';
        if (pattern === '') {
          process.stderr.write('Usage: bughunter suppress <pattern> --reason <text>\n');
          process.exitCode = 2;
          break;
        }
        const reason = typeof flags['reason'] === 'string' ? flags['reason'] : '';
        if (reason === '') {
          process.stderr.write('Error: --reason is required\n');
          process.exitCode = 2;
          break;
        }
        suppressCommand({
          projectDir,
          pattern,
          reason,
          expires: typeof flags['expires'] === 'string' ? flags['expires'] : undefined,
          clusterId: typeof flags['cluster-id'] === 'string' ? flags['cluster-id'] : undefined,
        });
        break;
      }

      case 'ingest': {
        const ingestPath = args[0] ?? '';
        if (ingestPath === '') {
          throw new Error('Usage: bughunter ingest <path-to-bugs.jsonl> [--run-id <id>] [--project-name <name>]');
        }
        ingestCommand(projectDir, {
          filePath: ingestPath,
          runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
          projectName: typeof flags['project-name'] === 'string' ? flags['project-name'] : undefined,
        });
        break;
      }

      case 'unsuppress': {
        const pattern = args[0] ?? '';
        if (pattern === '') {
          process.stderr.write('Usage: bughunter unsuppress <pattern>\n');
          process.exitCode = 2;
          break;
        }
        unsuppressCommand({ projectDir, pattern });
        break;
      }

      case 'triage': {
        await triageCliCommand({
          projectDir,
          runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
        });
        break;
      }

      case 'aging': {
        agingCommand(projectDir, {
          thresholdDays: typeof flags['threshold'] === 'string' ? parseInt(flags['threshold'], 10) : undefined,
          minRuns: typeof flags['min-runs'] === 'string' ? parseInt(flags['min-runs'], 10) : undefined,
        });
        break;
      }

      case 'explain': {
        const clusterId = args[0] ?? '';
        if (clusterId === '') {
          process.stderr.write('Usage: bughunter explain <clusterId> [--no-cache] [--run-id <id>]\n');
          process.exitCode = 2;
          break;
        }
        await explainCliCommand({
          projectDir,
          clusterId,
          noCache: flags['no-cache'] === true,
          runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
        });
        break;
      }

      case 'export': {
        const exportOpts = parseExportArgs(args, flags);
        exportCommand(projectDir, exportOpts);
        break;
      }

      case 'ci': {
        await ciCommand(projectDir, {
          projectDir,
          runId: typeof flags['runId'] === 'string' ? flags['runId'] : undefined,
          failOn: typeof flags['fail-on'] === 'string' ? flags['fail-on'] : undefined,
          report: typeof flags['report'] === 'string' ? flags['report'] : undefined,
          summaryMd: typeof flags['summary-md'] === 'string' ? flags['summary-md'] : undefined,
          diffAgainst: typeof flags['diff-against'] === 'string' ? flags['diff-against'] : undefined,
          upload: flags['upload'] === true,
          route: typeof flags['route'] === 'string' ? flags['route'] : undefined,
          role: typeof flags['role'] === 'string' ? flags['role'] : undefined,
          maxBugs: typeof flags['max-bugs'] === 'string' ? parseInt(flags['max-bugs'], 10) : undefined,
          maxRuntime: typeof flags['max-runtime'] === 'string' ? parseInt(flags['max-runtime'], 10) : undefined,
          budget: typeof flags['budget'] === 'string' ? parseInt(flags['budget'], 10) : undefined,
          concurrency: typeof flags['concurrency'] === 'string' ? parseInt(flags['concurrency'], 10) : undefined,
          apiConcurrency: typeof flags['api-concurrency'] === 'string' ? parseInt(flags['api-concurrency'], 10) : undefined,
        });
        break;
      }

      case 'publish': {
        const pubRunId = args[0] ?? '';
        if (pubRunId === '') throw new Error('Usage: bughunter publish <runId> --target <github>');
        const target = typeof flags['target'] === 'string' ? flags['target'] : '';
        if (target === '') {
          process.stderr.write('Missing --target. Only --target github is supported.\n');
          process.exit(2);
        }
        publishCommand(projectDir, {
          runId: pubRunId,
          target,
          ref: typeof flags['ref'] === 'string' ? flags['ref'] : undefined,
          sha: typeof flags['sha'] === 'string' ? flags['sha'] : undefined,
          report: typeof flags['report'] === 'string' ? flags['report'] : undefined,
        });
        break;
      }

      case 'bisect': {
        const bisectBugId = args[0] ?? '';
        const strict = flags['strict'] === true;
        const consensusN = typeof flags['consensus'] === 'string' ? parseInt(flags['consensus'], 10) : 3;
        const thresholdM = typeof flags['threshold'] === 'string'
          ? parseInt(flags['threshold'], 10)
          : Math.ceil(consensusN / 2);
        await bisectCommand(projectDir, bisectBugId, {
          commitRange: typeof flags['commit-range'] === 'string' ? flags['commit-range'] : undefined,
          consensus: strict ? 1 : consensusN,
          threshold: strict ? 1 : thresholdM,
          strict,
          buildCommand: typeof flags['build-command'] === 'string' ? flags['build-command'] : undefined,
          appCommand: typeof flags['app-command'] === 'string' ? flags['app-command'] : undefined,
          resume: flags['resume'] === true,
          noCleanup: flags['no-cleanup'] === true,
          format: flags['format'] === 'json' ? 'json' : 'text',
          jsonLog: flags['json-log'] === true,
          quiet: flags['quiet'] === true,
          noBuild: flags['no-build'] === true,
        });
        break;
      }

      case 'bisect-step': {
        // Hidden subcommand: invoked by git bisect run — not listed in USAGE.
        const stepBugId = typeof flags['bug-id'] === 'string' ? flags['bug-id'] : '';
        const bisectId = typeof flags['bisect-id'] === 'string' ? flags['bisect-id'] : '';
        const worktreeDir = typeof flags['worktree-dir'] === 'string' ? flags['worktree-dir'] : process.cwd();
        const stepProjectDir = typeof flags['project-dir'] === 'string' ? flags['project-dir'] : projectDir;
        if (stepBugId === '' || bisectId === '') {
          process.stderr.write('bisect-step: --bug-id and --bisect-id are required\n');
          process.exit(125);
        }
        await runBisectStep({ bugId: stepBugId, bisectId, projectDir: stepProjectDir, worktreeDir });
        break;
      }

      case 'self-test': {
        await selfTestCommand({
          projectDir,
          budgetMs: typeof flags['budget'] === 'string' ? parseInt(flags['budget'], 10) : undefined,
          maxBugs: typeof flags['max-bugs'] === 'string' ? parseInt(flags['max-bugs'], 10) : undefined,
          jsonOutput: flags['json'] === true,
          failOnFlake: flags['no-fail-on-flake'] === true ? false : true,
          keepRun: flags['keep-run'] === true,
          skipFixtureUp: flags['skip-fixture-up'] === true,
        });
        break;
      }

      case 'calibrate': {
        const appPath = typeof flags['app'] === 'string' ? flags['app'] : '';
        if (appPath === '') {
          process.stderr.write('Usage: bughunter calibrate --app <path> [options]\n');
          process.exitCode = 3;
          break;
        }
        try {
          await calibrateCommand({
            appPath,
            goldPath: typeof flags['gold'] === 'string' ? flags['gold'] : undefined,
            outPath: typeof flags['out'] === 'string' ? flags['out'] : undefined,
            enforceThresholds: flags['enforce-thresholds'] === true,
            thresholdsPath: typeof flags['thresholds'] === 'string' ? flags['thresholds'] : undefined,
            recordIdentities: flags['record-identities'] === true,
            force: flags['force'] === true,
            noBootTeardown: flags['no-boot'] === true,
            jsonOutput: flags['json'] === true,
          });
        } catch (e) {
          if (e instanceof CalibrateGoldError) {
            process.stderr.write(`[calibrate] Gold authoring error: ${e.message}\n`);
            process.exitCode = 3;
          } else if (e instanceof CalibrateEnvironmentError) {
            process.stderr.write(`[calibrate] Environment error: ${e.message}\n`);
            process.exitCode = 2;
          } else if (e instanceof CalibrateRunError) {
            process.stderr.write(`[calibrate] Run error: ${e.message}\n`);
            process.exitCode = 4;
          } else if (e instanceof CalibrateSetupError) {
            process.stderr.write(`[calibrate] Setup error: ${e.message}\n`);
            process.exitCode = 2;
          } else {
            throw e;
          }
        }
        break;
      }

      case 'notify-test': {
        await notifyTestCommand(projectDir, {
          json: flags['json'] === true,
        });
        break;
      }

      case 'view': {
        const { runViewCommand } = await import('./view.js');
        await runViewCommand({
          port: typeof flags['port'] === 'string' ? parseInt(flags['port'], 10) : undefined,
          noOpen: flags['no-open'] === true,
          mcp: typeof flags['mcp'] === 'string' ? flags['mcp'] : undefined,
          run: typeof flags['run'] === 'string' ? flags['run'] : undefined,
        });
        break;
      }

      case 'dataIntegrity': {
        const sub = args[0] ?? '';
        if (sub !== 'check') {
          process.stderr.write('Usage: bughunter dataIntegrity check [--only <name>] [--format table|json]\n');
          process.exitCode = 2;
          break;
        }
        const diFormat = typeof flags['format'] === 'string' ? (flags['format'] as 'table' | 'json') : undefined;
        const diOnly = typeof flags['only'] === 'string' ? [flags['only']] : undefined;
        dataIntegrityCheckCommand(projectDir, { onlyInvariant: diOnly, format: diFormat });
        break;
      }

      default:
        process.stdout.write(`${USAGE  }\n`);
        break;
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

main().catch(err => {
  log.error('Unexpected error', err);
  process.exit(1);
});
