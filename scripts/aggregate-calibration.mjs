#!/usr/bin/env node
// CI helper: aggregate calibration-report.json files from all 5 bench apps into one.
// Usage: node scripts/aggregate-calibration.mjs <report1.json> [report2.json ...]

import * as fs from 'node:fs';

const reportPaths = process.argv.slice(2);
if (reportPaths.length === 0) {
  process.stderr.write('Usage: aggregate-calibration.mjs <report1.json> [report2.json ...]\n');
  process.exit(1);
}

// Tolerate missing/empty reports — a single bench-app failing to come up healthy
// in CI must not zero out the entire aggregate. Skip with a stderr warning and
// emit `appsFailed` in the aggregate so downstream consumers can see what was
// dropped.
const appsFailed = [];
const reports = [];
for (const p of reportPaths) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    process.stderr.write(`Skipping unreadable report ${p}: ${err.message}\n`);
    appsFailed.push({ path: p, reason: 'unreadable' });
    continue;
  }
  if (raw.trim().length === 0) {
    process.stderr.write(`Skipping empty report ${p} — bench app likely failed to start\n`);
    appsFailed.push({ path: p, reason: 'empty' });
    continue;
  }
  try {
    reports.push(JSON.parse(raw));
  } catch (err) {
    process.stderr.write(`Skipping malformed report ${p}: ${err.message}\n`);
    appsFailed.push({ path: p, reason: 'malformed_json' });
  }
}
if (reports.length === 0) {
  process.stderr.write('No usable reports — every bench app failed.\n');
  process.exit(1);
}

// Union per-kind metrics across all reports
const kindTotals = new Map();
for (const report of reports) {
  for (const [kind, entry] of Object.entries(report.perKind ?? {})) {
    if (!kindTotals.has(kind)) {
      kindTotals.set(kind, { tp: 0, fp: 0, fn: 0, tn: 0, apps: [], registryStatus: entry.registryStatus });
    }
    const totals = kindTotals.get(kind);
    totals.tp += entry.tp;
    totals.fp += entry.fp;
    totals.fn += entry.fn;
    totals.tn += entry.tn;
    totals.apps.push(report.benchAppId);
  }
}

// Compute aggregate per-kind
const perKind = {};
for (const [kind, totals] of kindTotals.entries()) {
  const { tp, fp, fn, tn, apps, registryStatus } = totals;
  const precision = tp + fp === 0 ? 1.0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1.0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  perKind[kind] = {
    tp, fp, fn, tn,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    appsCovered: [...new Set(apps)],
    lowConfidence: tp + fn < 3,
    registryStatus,
  };
}

// Overall totals
const allTp = reports.reduce((s, r) => s + (r.overall?.tp ?? 0), 0);
const allFp = reports.reduce((s, r) => s + (r.overall?.fp ?? 0), 0);
const allFn = reports.reduce((s, r) => s + (r.overall?.fn ?? 0), 0);
const allTn = reports.reduce((s, r) => s + (r.overall?.tn ?? 0), 0);
const allClusters = reports.reduce((s, r) => s + (r.overall?.totalClusters ?? 0), 0);
const allGold = reports.reduce((s, r) => s + (r.overall?.totalGoldEntries ?? 0), 0);
const overallP = allTp + allFp === 0 ? 1.0 : allTp / (allTp + allFp);
const overallR = allTp + allFn === 0 ? 1.0 : allTp / (allTp + allFn);
const overallF1 = overallP + overallR === 0 ? 0 : (2 * overallP * overallR) / (overallP + overallR);

// Load thresholds for violation detection
let thresholds = { default: { precision: 0.85, recall: 0.80 }, perKind: {} };
try {
  const tPath = new URL('../acceptance-thresholds.json', import.meta.url).pathname;
  if (fs.existsSync(tPath)) {
    thresholds = JSON.parse(fs.readFileSync(tPath, 'utf-8'));
  }
} catch { /* use defaults */ }

const violations = [];
for (const [kind, entry] of Object.entries(perKind)) {
  if (entry.registryStatus === 'deferred') continue;
  if (entry.lowConfidence) continue;
  const threshold = thresholds.perKind?.[kind] ?? thresholds.default;
  if (entry.precision < threshold.precision || entry.recall < threshold.recall) {
    violations.push(kind);
  }
}

const aggregate = {
  version: 1,
  schemaVersion: 'v0.44.0',
  generatedAt: new Date().toISOString(),
  bughunterVersion: reports[0]?.bughunterVersion ?? 'unknown',
  bughunterCommit: reports[0]?.bughunterCommit ?? 'unknown',
  appsIncluded: reports.map(r => r.benchAppId),
  overall: {
    totalClusters: allClusters,
    totalGoldEntries: allGold,
    tp: allTp, fp: allFp, fn: allFn, tn: allTn,
    precision: Math.round(overallP * 1000) / 1000,
    recall: Math.round(overallR * 1000) / 1000,
    f1: Math.round(overallF1 * 1000) / 1000,
  },
  perKind,
  thresholdViolations: violations,
  appsFailed,
};

process.stdout.write(JSON.stringify(aggregate, null, 2) + '\n');
