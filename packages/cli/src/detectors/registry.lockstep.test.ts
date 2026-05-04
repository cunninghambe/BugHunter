// Lockstep enforcement test (§5.3 of SPEC_V33_SELF_TEST.md).
//
// Verifies that DETECTOR_REGISTRY, reuse-manifest.json, and golden-bugs.jsonl
// are all in sync:
//   - Every wired kind has exactly one manifest entry AND a positive golden expectation.
//   - Every deferred kind has an `expect: 'absent'` line OR is listed in manifest.deferred.
//
// This test is a static contract check. It imports no runtime code from self-test.ts.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTOR_REGISTRY } from './registry.js';
import { DETECTOR_CONTRACTS } from './contracts.js';

// ---------------------------------------------------------------------------
// File locations
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixtures', 'bughunter-self-deliberate-bugs');
const MANIFEST_PATH = path.join(FIXTURE_ROOT, 'reuse-manifest.json');
const GOLDEN_PATH = path.join(FIXTURE_ROOT, 'golden-bugs.jsonl');

// ---------------------------------------------------------------------------
// Load artifacts
// ---------------------------------------------------------------------------

type ManifestKindEntry = { fixture: string; port: number | null; route: string };
type ReuseManifest = { kinds: Record<string, ManifestKindEntry>; deferred: string[] };

type PositiveLine = { kind: string; signaturePrefix: string; fixture: string; specReference: string; acceptableMisses?: number };
type NegativeLine = { expect: 'absent'; kind: string; reason: string };
type DetectorSilentLine = { expect: 'detector_silent'; kind: string; reason: string; specReference?: string };
type GoldenLine = PositiveLine | NegativeLine | DetectorSilentLine;

function loadManifest(): ReuseManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(raw) as ReuseManifest;
}

function loadGolden(): GoldenLine[] {
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as GoldenLine);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DETECTOR_REGISTRY lockstep', () => {
  it('fixture files exist', () => {
    expect(fs.existsSync(MANIFEST_PATH), `reuse-manifest.json not found at ${MANIFEST_PATH}`).toBe(true);
    expect(fs.existsSync(GOLDEN_PATH), `golden-bugs.jsonl not found at ${GOLDEN_PATH}`).toBe(true);
  });

  it('every wired kind has exactly one manifest entry', () => {
    const manifest = loadManifest();
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const manifestKinds = new Set(Object.keys(manifest.kinds));

    const missing = wiredKinds.filter(k => !manifestKinds.has(k));
    expect(missing, `Wired kinds missing from reuse-manifest.json.kinds: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every wired kind has at least one positive expectation or detector_silent entry in golden-bugs.jsonl', () => {
    const golden = loadGolden();
    const wiredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind);
    const goldenPositiveKinds = new Set(
      golden.filter((l): l is PositiveLine => !('expect' in l)).map(l => l.kind),
    );
    const goldenSilentKinds = new Set(
      golden
        .filter((l): l is DetectorSilentLine => 'expect' in l && l.expect === 'detector_silent')
        .map(l => l.kind),
    );

    const missing = wiredKinds.filter(k => !goldenPositiveKinds.has(k) && !goldenSilentKinds.has(k));
    expect(
      missing,
      `Wired kinds with no positive expectation or detector_silent entry in golden-bugs.jsonl: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('every deferred kind has an absent expectation or manifest.deferred entry', () => {
    const manifest = loadManifest();
    const golden = loadGolden();
    const deferredKinds = DETECTOR_REGISTRY.filter(e => e.status === 'deferred').map(e => e.kind);

    const goldenNegativeKinds = new Set(
      golden.filter((l): l is NegativeLine => 'expect' in l && l.expect === 'absent').map(l => l.kind),
    );
    const manifestDeferred = new Set(manifest.deferred);

    const uncovered = deferredKinds.filter(k => !goldenNegativeKinds.has(k) && !manifestDeferred.has(k));
    expect(
      uncovered,
      `Deferred kinds with no absent expectation and not in manifest.deferred: ${uncovered.join(', ')}`,
    ).toHaveLength(0);
  });

  it('manifest has no extra entries not in DETECTOR_REGISTRY', () => {
    const manifest = loadManifest();
    const allKinds = new Set(DETECTOR_REGISTRY.map(e => e.kind));
    const extra = Object.keys(manifest.kinds).filter(k => !allKinds.has(k as never));
    expect(extra, `manifest.kinds has entries unknown to DETECTOR_REGISTRY: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('golden positive lines reference only kinds in DETECTOR_REGISTRY', () => {
    const golden = loadGolden();
    const allKinds = new Set(DETECTOR_REGISTRY.map(e => e.kind));
    const positives = golden.filter((l): l is PositiveLine => !('expect' in l));
    const unknown = positives.filter(l => !allKinds.has(l.kind as never)).map(l => l.kind);
    expect(unknown, `golden-bugs.jsonl positive lines reference unknown kinds: ${unknown.join(', ')}`).toHaveLength(0);
  });

  it('golden absent lines reference only deferred or dead kinds', () => {
    const golden = loadGolden();
    const deferredOrDead = new Set(
      DETECTOR_REGISTRY.filter(e => e.status !== 'wired').map(e => e.kind),
    );
    const negatives = golden.filter((l): l is NegativeLine => 'expect' in l && l.expect === 'absent');
    const invalid = negatives.filter(l => !deferredOrDead.has(l.kind as never)).map(l => l.kind);
    expect(
      invalid,
      `golden-bugs.jsonl absent lines reference wired kinds (should be positive expectation or detector_silent): ${invalid.join(', ')}`,
    ).toHaveLength(0);
  });

  it('golden detector_silent lines reference only wired kinds', () => {
    const golden = loadGolden();
    const wiredKinds = new Set(DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind));
    const silentLines = golden.filter(
      (l): l is DetectorSilentLine => 'expect' in l && l.expect === 'detector_silent',
    );
    const invalid = silentLines.filter(l => !wiredKinds.has(l.kind as never)).map(l => l.kind);
    expect(
      invalid,
      `golden-bugs.jsonl detector_silent lines reference non-wired kinds: ${invalid.join(', ')}`,
    ).toHaveLength(0);
  });

  it('all positive expectations have a signaturePrefix', () => {
    const golden = loadGolden();
    const positives = golden.filter((l): l is PositiveLine => !('expect' in l));
    const missing = positives.filter(l => !l.signaturePrefix || l.signaturePrefix.trim().length === 0).map(l => l.kind);
    expect(missing, `positive expectations without signaturePrefix: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('all positive expectations have a fixture field', () => {
    const golden = loadGolden();
    const positives = golden.filter((l): l is PositiveLine => !('expect' in l));
    const missing = positives.filter(l => !l.fixture).map(l => l.kind);
    expect(missing, `positive expectations without fixture field: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('wired kinds count matches registry', () => {
    const wiredCount = DETECTOR_REGISTRY.filter(e => e.status === 'wired').length;
    expect(wiredCount).toBeGreaterThan(0);
    // Sanity: we know from V33 the registry has 72 wired kinds; assert ≥ 60 to be resilient.
    expect(wiredCount).toBeGreaterThanOrEqual(60);
  });

  it('every wired entry detectorSite actually references the kind name in source', () => {
    // Catches the "registry-says-wired-but-not-actually-wired" pattern statically.
    // If the detectorSite file does not contain the kind name string, the detection
    // is never emitted and the entry should be marked deferred instead.
    // We check detectorSite (where the BugDetection literal is constructed) rather than
    // runnerSite (which calls classify functions that internally reference the kind).
    const errors: string[] = [];

    for (const entry of DETECTOR_REGISTRY) {
      if (entry.status !== 'wired') continue;
      if (!entry.detectorSite) continue; // no detectorSite declared, skip

      const detectorFile = path.resolve(REPO_ROOT, entry.detectorSite.split(':')[0]);
      if (!fs.existsSync(detectorFile)) {
        errors.push(`${entry.kind}: detectorSite '${entry.detectorSite}' does not exist on disk`);
        continue;
      }
      const contents = fs.readFileSync(detectorFile, 'utf-8');
      if (!contents.includes(entry.kind)) {
        errors.push(
          `${entry.kind}: detectorSite '${detectorFile}' contains no reference to kind name — likely dead detector; mark as deferred`,
        );
      }
    }

    expect(
      errors,
      `Wired detectors with no kind-name reference in their detectorSite:\n${errors.join('\n')}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// V56 lockstep: DETECTOR_CONTRACTS ↔ harness:true registry rows (advisory in V56.1–V56.5)
// Gate-flips to mandatory at V56.6 when all wired kinds must have harness:true + contract.
// ---------------------------------------------------------------------------

describe('V56 DETECTOR_CONTRACTS lockstep (advisory through V56.5)', () => {
  it('every harness:true registry row has exactly one DETECTOR_CONTRACTS entry', () => {
    const harnessKinds = DETECTOR_REGISTRY
      .filter(e => e.status === 'wired' && e.harness === true)
      .map(e => e.kind);

    const contractKinds = new Set(DETECTOR_CONTRACTS.map(c => c.kind));

    const missing = harnessKinds.filter(k => !contractKinds.has(k));
    expect(
      missing,
      `Registry rows with harness:true that have NO DetectorContract entry: ${missing.join(', ')}. ` +
      'Add a DetectorContract entry for each, or remove harness:true from the registry row.',
    ).toHaveLength(0);
  });

  it('every DETECTOR_CONTRACTS entry has a corresponding harness:true wired registry row', () => {
    const harnessKinds = new Set(
      DETECTOR_REGISTRY
        .filter(e => e.status === 'wired' && e.harness === true)
        .map(e => e.kind),
    );

    const orphaned = DETECTOR_CONTRACTS
      .filter(c => !harnessKinds.has(c.kind))
      .map(c => c.kind);

    expect(
      orphaned,
      `DetectorContract entries with no harness:true wired registry row: ${orphaned.join(', ')}. ` +
      'Either add harness:true to the registry row, or remove the contract entry.',
    ).toHaveLength(0);
  });

  it('DETECTOR_CONTRACTS entries have unique kinds', () => {
    const kinds = DETECTOR_CONTRACTS.map(c => c.kind);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const kind of kinds) {
      if (seen.has(kind)) duplicates.push(kind);
      seen.add(kind);
    }
    expect(duplicates, `Duplicate DetectorContract entries: ${duplicates.join(', ')}`).toHaveLength(0);
  });
});
