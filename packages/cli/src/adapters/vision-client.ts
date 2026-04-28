// Anthropic SDK wrapper for multimodal vision classification (§ 4.5).

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type VisionRequest = {
  imagePath: string;
  promptText: string;
  model: string;
  timeoutMs: number;
};

export type VisionResponse = {
  rawText: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export type VisionClientInterface = {
  classify(req: VisionRequest): Promise<VisionResponse>;
};

export class VisionApiError extends Error {
  constructor(
    public kind: 'auth' | 'timeout' | 'rate_limit' | 'transport' | 'malformed',
    message: string
  ) {
    super(message);
    this.name = 'VisionApiError';
  }
}

export type VisionAuth =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'claudeCli'; binaryPath: string };
// Note: 'oauth' removed — it never worked (see commit 6eb2d8f and v0.5 Q8).

export class AnthropicVisionClient implements VisionClientInterface {
  constructor(
    private readonly auth: VisionAuth,
    private readonly model: string,
    private readonly timeoutMs: number
  ) {}

  async classify(req: VisionRequest): Promise<VisionResponse> {
    if (this.auth.kind !== 'apiKey') {
      throw new VisionApiError('auth', 'AnthropicVisionClient requires apiKey auth; use ClaudeCliVisionClient for claudeCli auth');
    }
    const client = new Anthropic({ apiKey: this.auth.apiKey });
    const imageBytes = fs.readFileSync(req.imagePath);
    const imageB64 = imageBytes.toString('base64');
    const mediaType = path.extname(req.imagePath).toLowerCase() === '.jpg'
      ? 'image/jpeg' as const
      : 'image/png' as const;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const msg = await client.messages.create(
        {
          model: req.model,
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
              { type: 'text', text: req.promptText },
            ],
          }],
        },
        { signal: ctrl.signal }
      );

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      return {
        rawText: text,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      };
    } catch (err) {
      throw mapVisionError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapVisionError(err: unknown): VisionApiError {
  if (err instanceof VisionApiError) return err;

  const msg = err instanceof Error ? err.message : String(err);

  // AbortController timeout
  if (err instanceof Error && err.name === 'AbortError') {
    return new VisionApiError('timeout', `Vision API call timed out: ${msg}`);
  }

  // Anthropic API error shapes
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const status = typeof e['status'] === 'number' ? e['status'] : undefined;
    if (status === 401) return new VisionApiError('auth', `Vision API auth failed: ${msg}`);
    if (status === 429) return new VisionApiError('rate_limit', `Vision API rate limited: ${msg}`);
    if (status !== undefined && status >= 400) return new VisionApiError('transport', `Vision API error ${status}: ${msg}`);
  }

  // Network / transport errors
  if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return new VisionApiError('transport', `Vision API transport error: ${msg}`);
  }

  return new VisionApiError('transport', `Vision API unknown error: ${msg}`);
}
