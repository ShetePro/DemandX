import type { InferUITools, UIMessage } from 'ai';

import type { ChatTools } from './tools';

/**
 * Structured data parts chat can render next to text. `data-evidence` is what
 * a future tool result or server-side retrieval attaches; the renderer only
 * needs a platform label and one summary line.
 */
export type ChatDataTypes = {
  evidence: {
    id: string;
    platform: string;
    summary: string;
    url?: string;
  };
};

/**
 * One persisted or streamed chat message. Typing the tool set here is what makes
 * `part.input` / `part.output` useful in the renderer instead of `unknown`.
 */
export type ChatMessage = UIMessage<unknown, ChatDataTypes, InferUITools<ChatTools>>;
