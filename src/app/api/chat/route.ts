import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { z } from 'zod';

import { getChatModel } from '@/lib/chat/model';
import { CHAT_SYSTEM_PROMPT } from '@/lib/chat/system-prompt';
import { createChatTools } from '@/lib/chat/tools';
import type { ChatMessage } from '@/lib/chat/types';

// Streaming answers are slower than a page render; 60s covers a three-step
// tool loop on a local 7B model without holding the function open indefinitely.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * A deliberately loose subset of `UIMessage`: `parts` stay opaque objects and
 * are type-checked by the SDK's converter, so a new part type shipped by
 * `useChat` does not lock the request out.
 */
const chatRequestSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['system', 'user', 'assistant']),
      parts: z.array(z.object({ type: z.string() }).loose()),
    }),
  ),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });

  const model = await getChatModel();
  if (!model.ok) return Response.json({ error: model.code }, { status: 500 });

  const tools = createChatTools();
  const messages = parsed.data.messages as ChatMessage[];

  try {
    const result = streamText({
      model: model.value.model,
      system: CHAT_SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools,
      // One retrieval step plus one correction step is enough; a longer loop
      // costs tokens without improving the answer.
      stopWhen: stepCountIs(3),
    });

    return result.toUIMessageStreamResponse();
  } catch {
    // The provider was unreachable before the stream opened. Nothing has been
    // sent yet, so a plain JSON error is still a valid response.
    return Response.json({ error: 'CHAT_STREAM_FAILED' }, { status: 500 });
  }
}
