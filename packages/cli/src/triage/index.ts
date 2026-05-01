import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugCluster } from '../types.js';
import type { ClusterVerdictMark } from './types.js';
import type { TriageEvent } from './types.js';
import { appendJsonl } from '../store/filesystem.js';
import { bugHunterPaths } from '../suppress/io.js';
import { suppressCommand } from '../cli/suppress.js';
import { createId } from '@paralleldrive/cuid2';
import { log } from '../log.js';

export type ExplainResult = {
  markdown: string;
  cacheHit: boolean;
  cost?: number;
};

export type AppCallbacks = {
  onVerdict: (cluster: BugCluster, mark: ClusterVerdictMark) => void;
  onSuppress: (cluster: BugCluster, pattern: string, reason: string, actor: string, runId: string) => Promise<string>;
  onExplain: (cluster: BugCluster) => Promise<ExplainResult>;
  onExplainEvent: (cluster: BugCluster, cacheHit: boolean, cost: number | undefined, actor: string, runId: string) => void;
  onFixDispatched: (cluster: BugCluster, actor: string, runId: string) => void;
  onQuit: () => void;
};

export type TriageCommandOpts = {
  projectDir: string;
  clusters: BugCluster[];
  runId: string;
  actor: string;
};

export async function triageCommand(opts: TriageCommandOpts): Promise<void> {
  const { clusters, projectDir, runId, actor } = opts;

  if (clusters.length === 0) {
    process.stdout.write(`No clusters in run ${runId}; nothing to triage.\n`);
    return;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write('bughunter triage requires a TTY (--batch mode lands in v0.29)\n');
    process.exitCode = 2;
    return;
  }

  // Lazy import Ink to avoid paying React cold-start on `bughunter run`
  const { render } = await import('ink');
  const { App } = await import('./components/App.js');
  const React = (await import('react')).default;
  const { explainCluster } = await import('../explain/index.js');

  const paths = bugHunterPaths(projectDir);

  const callbacks: AppCallbacks = {
    onVerdict(cluster, mark) {
      const event: TriageEvent = {
        kind: 'verdict',
        timestamp: new Date().toISOString(),
        actor,
        runId,
        clusterId: cluster.id,
        bugIdentity: cluster.signatureKey,
        mark,
      };
      fs.mkdirSync(path.dirname(paths.triageFile), { recursive: true });
      appendJsonl(paths.triageFile, event);
    },

    onSuppress(cluster, pattern, reason, _actor, _runId): Promise<string> {
      const entryId = createId();
      suppressCommand({ projectDir, pattern, reason, clusterId: cluster.id });
      const event: TriageEvent = {
        kind: 'suppress',
        timestamp: new Date().toISOString(),
        actor,
        runId,
        clusterId: cluster.id,
        pattern,
        reason,
        suppressionId: entryId,
      };
      appendJsonl(paths.triageFile, event);
      return Promise.resolve(entryId);
    },

    async onExplain(cluster): Promise<ExplainResult> {
      return explainCluster({ cluster, projectDir });
    },

    onExplainEvent(cluster, cacheHit, cost, _actor, _runId) {
      const event: TriageEvent = {
        kind: 'explain-requested',
        timestamp: new Date().toISOString(),
        actor,
        runId,
        clusterId: cluster.id,
        cacheHit,
        cost,
      };
      appendJsonl(paths.triageFile, event);
    },

    onFixDispatched(cluster, _actor, _runId) {
      const event: TriageEvent = {
        kind: 'fix-dispatched',
        timestamp: new Date().toISOString(),
        actor,
        runId,
        clusterId: cluster.id,
      };
      appendJsonl(paths.triageFile, event);
      log.info(`Fix intent dispatched for cluster ${cluster.id}`);
    },

    onQuit() {
      instance.unmount();
    },
  };

  const instance = render(React.createElement(App, { clusters, actor, runId, callbacks }));
  await instance.waitUntilExit();
}
