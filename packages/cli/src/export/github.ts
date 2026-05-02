// v0.29: GitHub-flavoured SARIF emitter — wraps sarif.ts with 5000-truncate + path-relativity warn.

import type { BugCluster } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { SarifRunState, SarifLog } from './sarif.js';
import { renderSarif } from './sarif.js';

const GITHUB_RESULT_LIMIT = 5000;

export function renderGithubSarif(
  clusters: BugCluster[],
  state: SarifRunState,
  truncateAt = GITHUB_RESULT_LIMIT,
): { sarif: SarifLog; truncated: boolean; originalCount: number } {
  const originalCount = clusters.length;
  let truncated = false;

  if (originalCount > truncateAt) {
    process.stderr.write(
      `[bughunter] warn: Truncated ${originalCount} → ${truncateAt} results to fit GitHub code-scanning limit\n`,
    );
    clusters = clusters.slice(0, truncateAt);
    truncated = true;
  }

  for (const c of clusters) {
    const firstFile = c.suspectedFiles[0];
    if (firstFile !== undefined) {
      const p = suspectedFilePath(firstFile);
      if (p.startsWith('/')) {
        process.stderr.write(
          `[bughunter] warn: cluster ${c.id} suspectedFiles[0] is absolute path '${p}'; ` +
          'GitHub code-scanning expects SRCROOT-relative paths\n',
        );
      }
    }
  }

  return { sarif: renderSarif(clusters, state), truncated, originalCount };
}
