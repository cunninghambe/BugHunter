// Claude CLI subprocess vision client (v0.5 T04).
// Implements VisionClientInterface using `claude --print` subprocess.

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { VisionClientInterface, VisionRequest, VisionResponse, TextRequest } from './vision-client.js';
import { VisionApiError } from './vision-client.js';
import { z } from 'zod';

const ClaudeCliResponseSchema = z.object({
  result: z.string(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).optional(),
});

export class ClaudeCliVisionClient implements VisionClientInterface {
  constructor(
    private readonly binaryPath: string,
    private readonly model: string,
    private readonly timeoutMs: number
  ) {}

  async classifyText(req: TextRequest): Promise<VisionResponse> {
    return this.spawnClaude(req.promptText, req.model);
  }

  async classify(req: VisionRequest): Promise<VisionResponse> {
    const absoluteImagePath = path.resolve(req.imagePath);
    const prompt = `${req.promptText}\n\nThe screenshot is at: ${absoluteImagePath}`;

    return this.spawnClaude(prompt, req.model);
  }

  private async spawnClaude(prompt: string, model: string): Promise<VisionResponse> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--input-format', 'text',
        '--output-format', 'json',
        '--model', model,
      ];

      const child = spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill();
        reject(new VisionApiError('timeout', `Claude CLI vision timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new VisionApiError('transport', `Claude CLI spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new VisionApiError('transport', `Claude CLI exited ${code}: ${stderr}`));
          return;
        }

        const raw = Buffer.concat(stdoutChunks).toString();
        let jsonValue: unknown;
        try {
          jsonValue = JSON.parse(raw);
        } catch {
          reject(new VisionApiError('malformed', `Claude CLI response is not valid JSON: ${raw.slice(0, 200)}`));
          return;
        }
        const parsed = ClaudeCliResponseSchema.safeParse(jsonValue);
        if (!parsed.success) {
          reject(new VisionApiError('malformed', `Claude CLI response schema invalid: ${parsed.error.message}`));
          return;
        }

        resolve({
          rawText: parsed.data.result,
          usage: parsed.data.usage !== undefined ? {
            inputTokens: parsed.data.usage.input_tokens ?? 0,
            outputTokens: parsed.data.usage.output_tokens ?? 0,
          } : undefined,
        });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
