import type { BugCluster } from '../types.js';
import { suspectedFilePath } from '../types.js';
import type { FileExcerpt } from './excerpt.js';

const MAX_PROMPT_CHARS = 100_000;

function renderFileSection(excerpt: FileExcerpt): string {
  return `### ${excerpt.path}:${excerpt.firstLine}-${excerpt.lastLine}
\`\`\`
${excerpt.content}
\`\`\``;
}

function renderOccurrence(cluster: BugCluster): string {
  if (cluster.occurrences.length === 0) return '(no occurrences)';
  const occ = cluster.occurrences[0];
  return `- Role: ${occ.role}
- Page: ${occ.page}
- Action: ${occ.action.kind} on ${occ.action.selector ?? 'n/a'}`;
}

export function renderPrompt(cluster: BugCluster, excerpts: FileExcerpt[]): string {
  const evidenceParts = excerpts.map(renderFileSection).join('\n\n');
  const evidenceSection = evidenceParts.length > 0
    ? `## Evidence\n${evidenceParts}`
    : '';

  let prompt = `You are reviewing a bug that BugHunter found in the user's codebase. Output ONLY Markdown — no JSON, no shell, no preamble. Aim for under 400 words. Never speculate beyond the evidence below.

## Cluster
- Kind: ${cluster.kind}
- Identity: ${cluster.signatureKey ?? '(none)'}
- Cluster size: ${cluster.clusterSize}
- Root cause text: "${cluster.rootCause}"
- Suspected files: ${cluster.suspectedFiles.map(suspectedFilePath).join(', ')}

${evidenceSection}

## Sample occurrence
${renderOccurrence(cluster)}

Now write the explanation in this exact structure:

## What's happening
<2-4 sentences>

## Likely root cause
<2-4 sentences; cite the file:line if you can>

## How to fix
<bullet list of 1-3 concrete steps>

## What to verify after the fix
<bullet list of 1-2 verifications>`;

  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = `${prompt.slice(0, MAX_PROMPT_CHARS)}\n... (truncated for prompt size)`;
  }

  return prompt;
}
