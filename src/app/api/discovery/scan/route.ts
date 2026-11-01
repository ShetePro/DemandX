import { z } from 'zod';

import { findOpportunities } from '@/lib/discovery/find';
import { createDiscoveryRuntime } from '@/lib/discovery/runtime';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const inputSchema = z
  .object({
    excludeUrls: z.array(z.string().trim().max(2000)).max(300).optional(),
  })
  .strict();

type Phase = 'search' | 'filter' | 'model';

/**
 * NDJSON instead of a server action: the dialog must show which of the three
 * phases is running, and a single JSON response cannot update the UI until the
 * last one finishes.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const runtime = await createDiscoveryRuntime();
        const result = await findOpportunities({
          ...runtime,
          excludeUrls: parsed.data.excludeUrls ?? [],
          onPhase: (phase: Phase, detail?: number) => send({ type: 'phase', phase, detail }),
        });

        if (result.ok) send({ type: 'result', value: result.value });
        else send({ type: 'error', code: result.code, message: result.message });
      } catch {
        send({ type: 'error', code: 'SCAN_FAILED', message: '扫描失败：服务端错误' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
