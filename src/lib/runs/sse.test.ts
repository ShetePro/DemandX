import { describe, expect, it } from 'vitest';

import { formatSseEvent, parseAfterSeq } from './sse';

const STREAM_URL = 'http://127.0.0.1:3000/api/runs/1/stream';

function requestWith(headers: Record<string, string> = {}, url = STREAM_URL): Request {
  return new Request(url, { headers });
}

describe('formatSseEvent', () => {
  it('writes the cursor and one default message frame carrying the type', () => {
    expect(formatSseEvent({ id: 1, type: 'run.created', payload: { idea: 'a' } })).toBe(
      'id: 1\ndata: {"type":"run.created","payload":{"idea":"a"}}\n\n',
    );
  });

  it('never emits a named event, so onmessage receives every frame', () => {
    const frame = formatSseEvent({ id: 4, type: 'evidence.added', payload: { id: 'e1' } });

    expect(frame).not.toMatch(/^event: /m);
    expect(frame.split('\n').filter((line) => line.startsWith('event:'))).toHaveLength(0);
  });

  it('escapes newlines in a multi-line payload instead of breaking the frame', () => {
    const frame = formatSseEvent({
      id: 7,
      type: 'stage.progress',
      payload: { text: 'line 1\nline 2', note: 'a\r\nb' },
    });

    const dataLines = frame.split('\n').filter((line) => line.startsWith('data: '));
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toBe(
      'data: {"type":"stage.progress","payload":{"text":"line 1\\nline 2","note":"a\\r\\nb"}}',
    );
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('serializes a missing payload as null rather than dropping it', () => {
    expect(formatSseEvent({ id: 2, type: 'ping', payload: undefined })).toBe(
      'id: 2\ndata: {"type":"ping","payload":null}\n\n',
    );
  });
});

describe('parseAfterSeq', () => {
  it('starts from the beginning when no cursor is supplied', () => {
    expect(parseAfterSeq(requestWith())).toBe(0);
  });

  it('resumes from the Last-Event-ID header EventSource sends on reconnect', () => {
    expect(parseAfterSeq(requestWith({ 'Last-Event-ID': '12' }))).toBe(12);
  });

  it('reads the after_seq query parameter', () => {
    expect(parseAfterSeq(requestWith({}, `${STREAM_URL}?after_seq=7`))).toBe(7);
  });

  it('prefers the header over the query and ignores malformed cursors', () => {
    expect(parseAfterSeq(requestWith({ 'Last-Event-ID': '9' }, `${STREAM_URL}?after_seq=4`))).toBe(
      9,
    );
    expect(parseAfterSeq(requestWith({ 'Last-Event-ID': 'soon' }))).toBe(0);
    expect(parseAfterSeq(requestWith({}, `${STREAM_URL}?after_seq=-3`))).toBe(0);
    expect(parseAfterSeq(requestWith({}, `${STREAM_URL}?after_seq=1.5`))).toBe(0);
  });
});
