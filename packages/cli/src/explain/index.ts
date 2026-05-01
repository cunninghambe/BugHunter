import type { BugCluster } from '../types.js';
import { excerptSuspectedFiles } from './excerpt.js';
import { explainViaClaude } from './claude.js';
import { readCache, writeCache } from './cache.js';

export type ExplainClusterArgs = {
  cluster: BugCluster;
  projectDir: string;
  noCache?: boolean;
  timeoutMs?: number;
};

export type ExplainClusterResult = {
  markdown: string;
  cacheHit: boolean;
  cost?: number;
};

export async function explainCluster(args: ExplainClusterArgs): Promise<ExplainClusterResult> {
  const { cluster, projectDir, noCache = false, timeoutMs } = args;
  const cacheKey = cluster.signatureKey ?? cluster.id;

  if (!noCache) {
    const cached = readCache(projectDir, cacheKey);
    if (cached !== undefined) {
      return { markdown: cached, cacheHit: true, cost: 0 };
    }
  }

  const excerpts = excerptSuspectedFiles(cluster.suspectedFiles, projectDir);
  const result = await explainViaClaude({ cluster, suspectedFileExcerpts: excerpts, timeoutMs });
  writeCache(projectDir, cacheKey, result.markdown);

  return { markdown: result.markdown, cacheHit: false, cost: result.costUsd };
}
