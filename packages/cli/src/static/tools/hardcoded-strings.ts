// Hardcoded-string static analyzer (§6) — heuristic regex scanner, confidence: 'heuristic'.

import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { BugDetection } from '../../types.js';
import { log } from '../../log.js';

type HardcodedStringsOpts = {
  projectRoot: string;
  translationCallsites?: string[];
  extraExcludes?: string[];
  minStringLength?: number;
  requireWhitespace?: boolean;
};

// Default set of translation call-site names (§3.4 allowlist)
const DEFAULT_CALLSITES = ['t(', 'i18n.t(', 'useTranslation(', 'formatMessage(', '__(', '_(', 'gettext(', 'Lingui.', 'intl.formatMessage('];
const JSX_COMPONENTS = ['<Trans', '<FormattedMessage'];

// File patterns to exclude
const EXCLUDE_PATTERNS = [
  /\/node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\/coverage\//,
  /\.(?:test|spec|stories|d)\.[tj]sx?$/,
];

// Regex to match string literals and JSX text nodes
const STRING_RE = /(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")|>([^<>{}\s][^<>{}]*)</g;

function makeCallsiteRe(callsites: string[]): RegExp {
  const escaped = [...callsites.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ...JSX_COMPONENTS.map(c => c.replace(/[<]/g, '\\<'))];
  return new RegExp(`(?:${escaped.join('|')})\\s*$`);
}

function buildConsoleRe(): RegExp {
  return /console\.\w+\(\s*$/;
}

function buildImportRe(): RegExp {
  return /(?:import\b|from\s*$|require\()\s*$/;
}

function buildAriaDataRe(): RegExp {
  return /(?:data-\w+=|aria-(?!label|labelledby|description)\w+=)\s*$/;
}

async function glob(dir: string, exts: string[], extraExcludes: RegExp[]): Promise<string[]> {
  const results: string[] = [];
  const allExcludes = [...EXCLUDE_PATTERNS, ...extraExcludes];

  async function walk(d: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    await Promise.all(entries.map(async entry => {
      const full = path.join(d, entry);
      const s = await stat(full).catch(() => null);
      if (s === null) return;
      if (s.isDirectory()) {
        if (!allExcludes.some(re => re.test(full + '/'))) await walk(full);
      } else if (s.isFile() && exts.some(ext => full.endsWith(ext))) {
        if (!allExcludes.some(re => re.test(full))) results.push(full);
      }
    }));
  }

  await walk(dir);
  return results;
}

export async function runHardcodedStringsScanner(opts: HardcodedStringsOpts): Promise<BugDetection[]> {
  const {
    projectRoot,
    translationCallsites = DEFAULT_CALLSITES,
    extraExcludes = [],
    minStringLength = 3,
    requireWhitespace = true,
  } = opts;

  const startMs = Date.now();
  const extraExcludeRe = extraExcludes.map(p => new RegExp(p.replace(/\*/g, '.*')));
  const callsiteRe = makeCallsiteRe(translationCallsites);
  const consoleRe = buildConsoleRe();
  const importRe = buildImportRe();
  const ariaDataRe = buildAriaDataRe();

  const files = await glob(projectRoot, ['.ts', '.tsx', '.js', '.jsx'], extraExcludeRe);
  const detections: BugDetection[] = [];

  const BATCH_SIZE = 32;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async filePath => {
      let content: string;
      try {
        content = await readFile(filePath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split('\n');
      STRING_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = STRING_RE.exec(content)) !== null) {
        const literal = m[1] ?? m[2] ?? m[3] ?? '';
        const isJsx = m[3] !== undefined;

        if (literal.length < minStringLength) continue;
        if (!isJsx && requireWhitespace && !/\s/.test(literal)) continue;
        if (!/^[A-Za-z]/.test(literal.trim())) continue;

        // Find line number
        const upTo = content.slice(0, m.index);
        const lineIdx = upTo.split('\n').length - 1;
        const lineNum = lineIdx + 1;

        // 60-char window before the match
        const before60 = content.slice(Math.max(0, m.index - 60), m.index);

        if (callsiteRe.test(before60)) continue;
        if (consoleRe.test(before60)) continue;
        if (importRe.test(before60)) continue;
        if (ariaDataRe.test(before60)) continue;

        // Check for i18n-allow directive in preceding 2 lines
        const prevLines = lines.slice(Math.max(0, lineIdx - 2), lineIdx);
        if (prevLines.some(l => /\/\/\s*i18n-allow|eslint-disable-next-line bughunter\/i18n-hardcoded/.test(l))) continue;

        const relPath = path.relative(projectRoot, filePath);
        const clusterKey = `${relPath}:${lineNum}:${literal.slice(0, 30)}`;

        detections.push({
          kind: 'i18n_hardcoded_string',
          rootCause: `Hardcoded string "${literal.slice(0, 80)}" at ${relPath}:${lineNum}`,
          staticContext: {
            tool: 'hardcoded-strings',
            ruleId: 'i18n_hardcoded_string',
            sourceFile: filePath,
            sourceLine: lineNum,
          },
          evidence: {
            confidence: 'heuristic',
            clusterKey,
            literalPreview: literal.slice(0, 80),
          },
        });
      }
    }));
  }

  const elapsed = Date.now() - startMs;
  if (elapsed > 200) {
    log.warn('locale-stress: hardcoded-strings scanner exceeded 200ms budget', { elapsedMs: elapsed, filesScanned: files.length });
  }

  return detections;
}

export { runHardcodedStringsScanner as run };
