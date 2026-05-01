// bughunter ingest — import a bugs.jsonl from another run into history.db.

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { openHistoryDb } from '../store/history.js';
import { computeBugIdentity } from '../cluster/bug-identity.js';

// Minimal Zod schema for a BugCluster line. Uses passthrough() for forward compat with newer fields.
const IngestClusterSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  rootCause: z.string(),
  clusterSize: z.number().int().min(0),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  occurrences: z.array(z.unknown()),
  suspectedFiles: z.array(z.string()),
  fixHints: z.array(z.string()),
  thirdPartyOrGenerated: z.boolean(),
  signatureKey: z.string().optional(),
  bugIdentity: z.string().optional(),
  verdict: z.string().optional(),
}).passthrough();

type IngestCluster = z.infer<typeof IngestClusterSchema>;

export function ingestCommand(
  projectDir: string,
  opts: {
    filePath: string;
    runId?: string;
    projectName?: string;
  },
): void {
  if (!fs.existsSync(opts.filePath)) {
    throw new Error(`File not found: ${opts.filePath}`);
  }

  const content = fs.readFileSync(opts.filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim() !== '');

  const clusters: IngestCluster[] = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i] as string);
    } catch {
      throw new Error(`ingest: JSON parse error on line ${i + 1} of ${opts.filePath}`);
    }
    const result = IngestClusterSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`ingest: validation error on line ${i + 1}: ${result.error.message}`);
    }
    clusters.push(result.data);
  }

  if (clusters.length === 0) {
    process.stdout.write('No clusters found in file.\n');
    return;
  }

  const effectiveRunId = opts.runId ?? deriveRunId(opts.filePath, content);

  const rawProjectName = opts.projectName;
  if (rawProjectName === undefined || rawProjectName === '') {
    throw new Error('Unable to determine project name. Provide --project-name <name>.');
  }

  const db = openHistoryDb(projectDir);
  try {
    const insertRun = db.prepare(
      `INSERT OR REPLACE INTO runs (run_id, project_name, started_at, ended_at, total_clusters, config_hash, bughunter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCluster = db.prepare(
      `INSERT OR REPLACE INTO clusters (bug_identity, run_id, cluster_id, kind, cluster_size, root_cause, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const startedAt = clusters[0]?.firstSeenAt ?? new Date().toISOString();
    let inserted = 0;
    let skipped = 0;

    const tx = db.transaction(() => {
      insertRun.run(
        effectiveRunId,
        rawProjectName,
        startedAt,
        clusters[clusters.length - 1]?.lastSeenAt ?? null,
        clusters.length,
        'ingest',
        'external',
      );
      for (const c of clusters) {
        const sig = c.signatureKey;
        if (sig === undefined || sig === '') {
          skipped++;
          return;
        }
        const bugIdentity = c.bugIdentity ?? computeBugIdentity(rawProjectName, sig);
        insertCluster.run(bugIdentity, effectiveRunId, c.id, c.kind, c.clusterSize, c.rootCause.slice(0, 4096), c.verdict ?? null);
        inserted++;
      }
    });
    tx();
    const skipMsg = skipped > 0 ? ` (${skipped} skipped — no signatureKey)` : '';
    process.stdout.write(`Ingested ${inserted} cluster(s) into run ${effectiveRunId}${skipMsg}.\n`);
  } finally {
    db.close();
  }
}

function deriveRunId(filePath: string, content: string): string {
  const basename = path.basename(filePath, '.jsonl');
  const prefix = content.slice(0, 1024);
  const hash = createHash('sha256').update(basename).update(prefix).digest('hex').slice(0, 12);
  return `ingest-${hash}`;
}
