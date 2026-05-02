// v0.43: SSE / chunked HTTP streaming observer.
// Tracks per-stream completion and classifies truncation.

import type { BugDetection, AgentConfig } from '../types.js';

// Default terminal markers per § 3.4
const DEFAULT_TERMINAL_MARKERS = ['data: [DONE]', 'event: done', 'event: end', '{"type":"message_stop"}'];

// Minimum stream stale window (ms) before firing reason=no_terminal_event on punctuation check
const DEFAULT_STALE_MS = 5_000;

// Sentence-terminating punctuation characters
const TERMINAL_PUNCTUATION = new Set(['.', '!', '?', ':', ')', ']', '}']);

export type StreamHandle = {
  streamId: string;
  url: string;
  startedAt: number;
  protocol: 'sse' | 'chunked' | 'fetch_stream';
};

export type StreamOutcome =
  | { kind: 'completed'; chunkCount: number; totalBytes: number; durationMs: number; finalEventName?: string }
  | { kind: 'truncated'; chunkCount: number; lastEventName?: string; lastChunkSnippet: string; reason: 'connection_closed' | 'no_terminal_event' | 'mid_utf8_byte' }
  | { kind: 'aborted_by_user' }
  | { kind: 'no_stream_observed' };

export type StreamCompletion = {
  handle: StreamHandle;
  outcome: StreamOutcome;
  chunkCount: number;
  totalBytes: number;
  endedAt: number;
  terminalEventSeen: boolean;
};

export type StreamingObserver = {
  beginStream(handle: StreamHandle): void;
  recordChunk(streamId: string, bytes: Uint8Array, eventName?: string): void;
  endStream(streamId: string, reason: 'natural' | 'connection_closed' | 'aborted_by_user'): StreamCompletion;
  classifyAll(): BugDetection[];
};

type StreamState = {
  handle: StreamHandle;
  chunks: Uint8Array[];
  chunkCount: number;
  totalBytes: number;
  terminalEventSeen: boolean;
  lastEventName?: string;
  lastChunkAt: number;
  completion?: StreamCompletion;
};

export function makeStreamingObserver(cfg: AgentConfig): StreamingObserver {
  const terminalMarkers = cfg.streamTerminalMarkers ?? DEFAULT_TERMINAL_MARKERS;
  const staleMs = cfg.streamStaleChunkMs ?? DEFAULT_STALE_MS;
  const streams = new Map<string, StreamState>();
  const completed: StreamCompletion[] = [];

  function hasTerminalMarker(text: string): boolean {
    return terminalMarkers.some(m => text.includes(m));
  }

  function decodeChunk(bytes: Uint8Array): { text: string; midUtf8: boolean } {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      return { text: decoder.decode(bytes), midUtf8: false };
    } catch {
      const lenient = new TextDecoder('utf-8', { fatal: false });
      return { text: lenient.decode(bytes), midUtf8: true };
    }
  }

  function lastChunkSnippet(state: StreamState): string {
    if (state.chunks.length === 0) return '';
    const { text } = decodeChunk(state.chunks[state.chunks.length - 1]);
    return text.slice(0, 200);
  }

  return {
    beginStream(handle: StreamHandle) {
      streams.set(handle.streamId, {
        handle,
        chunks: [],
        chunkCount: 0,
        totalBytes: 0,
        terminalEventSeen: false,
        lastChunkAt: handle.startedAt,
      });
    },

    recordChunk(streamId: string, bytes: Uint8Array, eventName?: string) {
      const state = streams.get(streamId);
      if (state === undefined) return;
      state.chunks.push(bytes);
      state.chunkCount++;
      state.totalBytes += bytes.length;
      state.lastChunkAt = Date.now();
      if (eventName !== undefined) state.lastEventName = eventName;

      const { text } = decodeChunk(bytes);
      if (hasTerminalMarker(text)) state.terminalEventSeen = true;
    },

    endStream(streamId: string, reason: 'natural' | 'connection_closed' | 'aborted_by_user'): StreamCompletion {
      const state = streams.get(streamId);
      const endedAt = Date.now();

      if (state === undefined) {
        const fallback: StreamCompletion = {
          handle: { streamId, url: '', startedAt: endedAt, protocol: 'sse' },
          outcome: { kind: 'no_stream_observed' },
          chunkCount: 0,
          totalBytes: 0,
          endedAt,
          terminalEventSeen: false,
        };
        completed.push(fallback);
        return fallback;
      }

      streams.delete(streamId);
      const durationMs = endedAt - state.handle.startedAt;

      let outcome: StreamOutcome;
      if (reason === 'aborted_by_user') {
        outcome = { kind: 'aborted_by_user' };
      } else if (reason === 'connection_closed' && !state.terminalEventSeen) {
        outcome = {
          kind: 'truncated',
          chunkCount: state.chunkCount,
          lastEventName: state.lastEventName,
          lastChunkSnippet: lastChunkSnippet(state),
          reason: 'connection_closed',
        };
      } else if (state.terminalEventSeen) {
        outcome = {
          kind: 'completed',
          chunkCount: state.chunkCount,
          totalBytes: state.totalBytes,
          durationMs,
          finalEventName: state.lastEventName,
        };
      } else {
        // No terminal marker — check if last chunk is mid-UTF-8 or stale
        if (state.chunks.length === 0) {
          outcome = { kind: 'no_stream_observed' };
        } else {
          const last = state.chunks[state.chunks.length - 1];
          const { midUtf8 } = decodeChunk(last);
          if (midUtf8) {
            outcome = {
              kind: 'truncated',
              chunkCount: state.chunkCount,
              lastEventName: state.lastEventName,
              lastChunkSnippet: lastChunkSnippet(state),
              reason: 'mid_utf8_byte',
            };
          } else {
            // Check stale: elapsed since last chunk > staleMs AND no terminal punctuation
            const sinceLastChunk = endedAt - state.lastChunkAt;
            const { text } = decodeChunk(last);
            const endsWithTerminalPunctuation = text.trim().length > 0 && TERMINAL_PUNCTUATION.has(text.trim().slice(-1));
            if (state.handle.protocol === 'sse' && sinceLastChunk > staleMs && !endsWithTerminalPunctuation) {
              outcome = {
                kind: 'truncated',
                chunkCount: state.chunkCount,
                lastEventName: state.lastEventName,
                lastChunkSnippet: lastChunkSnippet(state),
                reason: 'no_terminal_event',
              };
            } else if (state.handle.protocol !== 'sse') {
              // chunked/fetch_stream without configured terminal markers — skip classification
              outcome = { kind: 'no_stream_observed' };
            } else {
              outcome = {
                kind: 'completed',
                chunkCount: state.chunkCount,
                totalBytes: state.totalBytes,
                durationMs,
              };
            }
          }
        }
      }

      const completion: StreamCompletion = {
        handle: state.handle,
        outcome,
        chunkCount: state.chunkCount,
        totalBytes: state.totalBytes,
        endedAt,
        terminalEventSeen: state.terminalEventSeen,
      };
      completed.push(completion);
      return completion;
    },

    classifyAll(): BugDetection[] {
      const bugs: BugDetection[] = [];
      for (const c of completed) {
        if (c.outcome.kind !== 'truncated') continue;
        const { outcome } = c;
        bugs.push({
          kind: 'streaming_response_truncated',
          rootCause: `Streaming response truncated (${outcome.reason}) on ${c.handle.url}`,
          endpoint: c.handle.url,
          agentContext: {
            turnId: c.handle.streamId,
            streamId: c.handle.streamId,
            proof: {
              kind: 'truncated',
              reason: outcome.reason,
              lastChunkSnippet: outcome.lastChunkSnippet,
              chunkCount: outcome.chunkCount,
              durationMs: c.endedAt - c.handle.startedAt,
            },
          },
        });
      }
      return bugs;
    },
  };
}
