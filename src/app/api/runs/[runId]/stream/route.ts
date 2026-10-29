import { setTimeout as delay } from 'node:timers/promises';

import { EVENT_PAGE_SIZE, TERMINAL_RUN_STATUSES, getRun, readEvents } from '@/lib/runs/repository';
import { formatSseEvent, parseAfterSeq } from '@/lib/runs/sse';

export const dynamic = 'force-dynamic';

// A run is polled rather than pushed to until the worker exists; 500ms keeps
// first paint quick without hammering the database on idle runs.
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;

const encoder = new TextEncoder();

type RouteContext = { params: Promise<{ runId: string }> };

function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

/**
 * Append-only event stream. Read-only by design: it never writes an event, so
 * reconnecting with `after_seq`/`Last-Event-ID` cannot duplicate anything.
 */
export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);

  if (!Number.isInteger(runId) || runId <= 0) {
    return jsonError(404, 'run_not_found', 'Run 不存在');
  }

  const existing = await getRun(runId);
  if (!existing.ok) return jsonError(500, 'storage_failed', '读取运行记录失败');
  if (existing.value === null) return jsonError(404, 'run_not_found', 'Run 不存在');

  let after = parseAfterSeq(request);
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastPing = Date.now();

      try {
        while (!cancelled && !request.signal.aborted) {
          const batch = await readEvents(runId, after);
          // Closing lets EventSource reconnect with the same cursor; a storage
          // blip must not be reported as a run failure.
          if (!batch.ok) break;

          for (const event of batch.value) {
            const frame = formatSseEvent({
              id: event.seq,
              type: event.type,
              data: event.payload,
            });
            controller.enqueue(encoder.encode(frame));
            after = event.seq;
          }

          // A full page means more events are already waiting; read again
          // without sleeping so a busy run streams back-to-back.
          if (batch.value.length >= EVENT_PAGE_SIZE) continue;

          const current = await getRun(runId);
          if (!current.ok || current.value === null) break;
          if (batch.value.length === 0 && TERMINAL_RUN_STATUSES[current.value.status] === true) {
            break;
          }

          if (Date.now() - lastPing >= HEARTBEAT_INTERVAL_MS) {
            controller.enqueue(encoder.encode(': ping\n\n'));
            lastPing = Date.now();
          }

          await delay(POLL_INTERVAL_MS, undefined, { signal: request.signal });
        }

        controller.close();
      } catch {
        // The consumer went away; a late enqueue/close throws and is ignored.
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
