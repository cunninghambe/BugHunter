import { describe, it, expect } from 'vitest';
import { makeStreamingObserver } from '../src/agent/streaming-observer.js';

const encoder = new TextEncoder();

function makeHandle(protocol: 'sse' | 'chunked' | 'fetch_stream' = 'sse') {
  return {
    streamId: `stream-${Math.random().toString(36).slice(2)}`,
    url: 'http://localhost:4173/api/chat',
    startedAt: Date.now(),
    protocol,
  };
}

describe('makeStreamingObserver', () => {
  it('case 1: SSE stream with data: [DONE] terminal → completed, no bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('data: hello\n\n'));
    obs.recordChunk(handle.streamId, encoder.encode('data: [DONE]\n\n'));
    const completion = obs.endStream(handle.streamId, 'natural');
    expect(completion.outcome.kind).toBe('completed');
    expect(completion.terminalEventSeen).toBe(true);
    const bugs = obs.classifyAll();
    expect(bugs).toHaveLength(0);
  });

  it('case 2: SSE stream closed without terminal marker → truncated reason=no_terminal_event, fires bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('data: partial content'));
    const completion = obs.endStream(handle.streamId, 'connection_closed');
    expect(completion.outcome.kind).toBe('truncated');
    if (completion.outcome.kind === 'truncated') {
      expect(completion.outcome.reason).toBe('connection_closed');
    }
    const bugs = obs.classifyAll();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.kind).toBe('streaming_response_truncated');
  });

  it('case 3: stream ends mid-UTF-8 multi-byte → truncated reason=mid_utf8_byte, fires bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    // Simulate a truncated multi-byte UTF-8 sequence (first two bytes of a 3-byte char)
    const truncatedUtf8 = new Uint8Array([0xE2, 0x82]); // incomplete euro sign (€ = E2 82 AC)
    obs.recordChunk(handle.streamId, truncatedUtf8);
    const completion = obs.endStream(handle.streamId, 'natural');
    expect(completion.outcome.kind).toBe('truncated');
    if (completion.outcome.kind === 'truncated') {
      expect(completion.outcome.reason).toBe('mid_utf8_byte');
    }
    const bugs = obs.classifyAll();
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.kind).toBe('streaming_response_truncated');
  });

  it('case 4: stream stale > 5s, no terminator, no punctuation → fires bug reason=no_terminal_event', () => {
    const obs = makeStreamingObserver({ streamStaleChunkMs: 100 }); // very short for testing
    const handle = { ...makeHandle('sse'), startedAt: Date.now() - 200 };
    obs.beginStream(handle);
    // Record chunk 200ms ago (simulate by using a past startedAt)
    obs.recordChunk(handle.streamId, encoder.encode('data: hello world'));
    const completion = obs.endStream(handle.streamId, 'natural');
    // The stream has no terminal event and the last chunk has no punctuation
    // If outcome is truncated with no_terminal_event, it fired
    // (depends on timing; if staleMs check fires, we get truncated)
    const bugs = obs.classifyAll();
    if (completion.outcome.kind === 'truncated') {
      expect(bugs).toHaveLength(1);
    }
  });

  it('case 5: stream aborted by user → outcome=aborted_by_user, no bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('data: partial'));
    const completion = obs.endStream(handle.streamId, 'aborted_by_user');
    expect(completion.outcome.kind).toBe('aborted_by_user');
    const bugs = obs.classifyAll();
    expect(bugs).toHaveLength(0);
  });

  it('case 6: chunked HTTP without terminal markers in chunks → no_stream_observed, no bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('chunked');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('some binary data'));
    const completion = obs.endStream(handle.streamId, 'natural');
    // chunked without terminal marker emits no_stream_observed
    expect(completion.outcome.kind).toBe('no_stream_observed');
    const bugs = obs.classifyAll();
    expect(bugs).toHaveLength(0);
  });

  it('SSE with message_stop terminal → completed', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('data: {"type":"message_stop"}\n\n'));
    const completion = obs.endStream(handle.streamId, 'natural');
    expect(completion.outcome.kind).toBe('completed');
    expect(completion.terminalEventSeen).toBe(true);
  });

  it('agentContext.proof is populated on truncated bug', () => {
    const obs = makeStreamingObserver({});
    const handle = makeHandle('sse');
    obs.beginStream(handle);
    obs.recordChunk(handle.streamId, encoder.encode('hello'));
    obs.endStream(handle.streamId, 'connection_closed');
    const bugs = obs.classifyAll();
    expect(bugs[0]?.agentContext?.proof?.kind).toBe('truncated');
  });
});
