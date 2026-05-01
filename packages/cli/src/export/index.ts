// v0.29: ExportFormat union + dispatch.

import type { BugCluster } from '../types.js';
import type { SarifRunState } from './sarif.js';
import { renderSarif } from './sarif.js';
import { renderGithubSarif } from './github.js';
import { renderGitlab } from './gitlab.js';
import { renderCsv } from './csv.js';
import { renderLinear } from './linear.js';
import { renderJira } from './jira.js';

export type ExportFormat = 'sarif' | 'github' | 'gitlab' | 'csv' | 'linear' | 'jira';

export type ExportOptions = {
  format: ExportFormat;
  clusters: BugCluster[];
  state: SarifRunState;
  truncateAt?: number;
};

export type ExportResult =
  | { ok: true; content: string; ext: string; truncated: boolean }
  | { ok: false; reason: string };

function assertNever(x: never): never {
  throw new Error(`Unhandled export format: ${String(x)}`);
}

export function runExport(opts: ExportOptions): ExportResult {
  const { format, clusters, state } = opts;

  switch (format) {
    case 'sarif': {
      const sarif = renderSarif(clusters, state);
      return { ok: true, content: JSON.stringify(sarif, null, 2), ext: 'json', truncated: false };
    }
    case 'github': {
      const { sarif, truncated } = renderGithubSarif(clusters, state, opts.truncateAt);
      return { ok: true, content: JSON.stringify(sarif, null, 2), ext: 'sarif', truncated };
    }
    case 'gitlab': {
      const report = renderGitlab(clusters, state.startedAt);
      return { ok: true, content: JSON.stringify(report, null, 2), ext: 'json', truncated: false };
    }
    case 'csv': {
      return { ok: true, content: renderCsv(clusters), ext: 'csv', truncated: false };
    }
    case 'linear': {
      const drafts = renderLinear(clusters);
      return { ok: true, content: JSON.stringify(drafts, null, 2), ext: 'json', truncated: false };
    }
    case 'jira': {
      const drafts = renderJira(clusters);
      return { ok: true, content: JSON.stringify(drafts, null, 2), ext: 'json', truncated: false };
    }
    default:
      return assertNever(format);
  }
}

export function defaultExtension(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : format === 'github' ? 'sarif' : 'json';
}
