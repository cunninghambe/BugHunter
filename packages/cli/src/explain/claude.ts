import { spawn } from 'node:child_process';
import type { BugCluster } from '../types.js';
import type { FileExcerpt } from './excerpt.js';
import { renderPrompt } from './prompt.js';

export type ExplainArgs = {
  cluster: BugCluster;
  suspectedFileExcerpts: FileExcerpt[];
  timeoutMs?: number;
};

export type ExplainResult = {
  markdown: string;
  costUsd: number;
};

export class ExplainError extends Error {
  constructor(
    message: string,
    public readonly code?: number | null,
    public readonly signal?: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = 'ExplainError';
  }
}

// Estimated cost: claude-sonnet ~$3/MTok in, $15/MTok out
const COST_PER_INPUT_TOKEN = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;
const ESTIMATED_OUTPUT_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const COST_CAP_USD = 0.50;

export async function explainViaClaude(args: ExplainArgs): Promise<ExplainResult> {
  const { cluster, suspectedFileExcerpts, timeoutMs = 60_000 } = args;
  const prompt = renderPrompt(cluster, suspectedFileExcerpts);

  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const estimatedCost =
    estimatedInputTokens * COST_PER_INPUT_TOKEN +
    ESTIMATED_OUTPUT_TOKENS * COST_PER_OUTPUT_TOKEN;

  if (estimatedCost > COST_CAP_USD) {
    throw new ExplainError(
      `Estimated cost $${estimatedCost.toFixed(4)} exceeds cap $${COST_CAP_USD}/cluster`,
    );
  }

  return new Promise<ExplainResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['-p'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reject(new ExplainError(
          "bughunter explain requires the 'claude' CLI on PATH; install per https://docs.anthropic.com/",
        ));
      } else {
        reject(new ExplainError(String(err)));
      }
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      reject(new ExplainError('claude -p timed out'));
    }, timeoutMs);

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new ExplainError(
          "bughunter explain requires the 'claude' CLI on PATH; install per https://docs.anthropic.com/",
        ));
      } else {
        reject(new ExplainError(String(err)));
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ExplainError(`claude -p exited with code ${code}: ${stderr.join('')}`, code, signal));
        return;
      }
      const markdown = stdout.join('');
      const outputTokens = Math.ceil(markdown.length / CHARS_PER_TOKEN);
      const costUsd = estimatedInputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
      resolve({ markdown, costUsd });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
