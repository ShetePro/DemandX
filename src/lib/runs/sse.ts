/** One frame of the event stream; `id` is the resume cursor (`run_events.seq`). */
export type SseEvent = { id: number; type: string; payload: unknown };

/**
 * Serialize one server-sent event as a default `message` frame. The event name
 * travels inside the JSON body (`{ type, payload }`) instead of an `event:`
 * line: `EventSource.onmessage` only sees unnamed frames, so a named frame
 * needs the client to register every type by hand and silently drops any type
 * it does not know about yet.
 *
 * `JSON.stringify` escapes every newline in the payload, so the frame always
 * has exactly one `data:` line and cannot be terminated early by user text.
 */
export function formatSseEvent({ id, type, payload }: SseEvent): string {
  return `id: ${id}\ndata: ${JSON.stringify({ type, payload: payload ?? null })}\n\n`;
}

const SEQ_PATTERN = /^\d+$/;

function parseSeq(raw: string | null): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!SEQ_PATTERN.test(value)) return null;

  const seq = Number(value);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * Where the stream should resume. `Last-Event-ID` is what EventSource sends on
 * its own reconnect; `?after_seq=` is for a first load and for clients that
 * rebuild the URL themselves. A malformed header falls back to the query, and
 * only when both are unusable does the stream start from 0.
 */
export function parseAfterSeq(request: Request): number {
  const fromHeader = parseSeq(request.headers.get('last-event-id'));
  if (fromHeader !== null) return fromHeader;

  const fromQuery = parseSeq(new URL(request.url).searchParams.get('after_seq'));
  return fromQuery ?? 0;
}
