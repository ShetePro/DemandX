import type { ChatMessage } from './types';

/** The subset of a persisted message row this module needs. */
export type StoredMessageRecord = {
  id: number;
  role: string;
  parts: unknown;
};

type PersistedOption = { id: string; label: string; description?: string };

function readOptions(value: unknown): PersistedOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const options: PersistedOption[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, label, description } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.trim() === '') continue;
    if (typeof label !== 'string' || label.trim() === '') continue;
    options.push({
      id,
      label,
      ...(typeof description === 'string' ? { description } : {}),
    });
  }
  return options.length === 0 ? null : options;
}

/**
 * A stored option card keeps only `{ type, options }` so the renderer can show
 * it after a reload. Sent to the model as-is, that part converts into a
 * `tool-call` with no arguments and no matching `tool-result`, and the provider
 * rejects the whole request. Rebuilding the call and its (real) result keeps
 * the card, and every later turn in the thread, valid.
 */
function hydrateToolPart(
  part: unknown,
  messageId: number,
  index: number,
): ChatMessage['parts'][number] | null {
  if (typeof part !== 'object' || part === null) return null;

  const record = part as Record<string, unknown>;
  if (record.type !== 'tool-present_options') return null;
  // A streamed part already has its call id and result; only stored cards
  // arrive stripped.
  if (typeof record.toolCallId === 'string') return null;

  const options = readOptions(record.options);
  if (options === null) return null;

  return {
    type: 'tool-present_options',
    toolCallId: `stored-${messageId}-${index}`,
    state: 'output-available',
    input: { options },
    output: { status: 'shown' },
  };
}

/**
 * Persisted rows are untrusted and display-shaped: unknown part types are
 * skipped, and option cards are completed into the tool part the model needs.
 */
export function toChatMessages(records: readonly StoredMessageRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const record of records) {
    if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'system') {
      continue;
    }
    if (!Array.isArray(record.parts)) continue;

    const parts: ChatMessage['parts'] = [];
    record.parts.forEach((part, index) => {
      const hydrated = hydrateToolPart(part, record.id, index);
      parts.push((hydrated ?? part) as ChatMessage['parts'][number]);
    });

    messages.push({
      id: String(record.id),
      role: record.role,
      parts,
    });
  }

  return messages;
}
