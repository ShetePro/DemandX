import { convertToModelMessages } from 'ai';
import { describe, expect, it } from 'vitest';

import { toChatMessages } from './history';
import type { ChatMessage } from './types';

const STORED_OPTIONS = [
  { id: 'wait', label: '继续等待研究结果', description: 'run #234 仍在队列' },
  { id: 'narrow', label: '收窄方向重跑研究' },
];

function storedRecord(parts: unknown[]) {
  return { id: 150, role: 'assistant', parts };
}

describe('toChatMessages', () => {
  it('keeps text parts and drops unknown roles', () => {
    const messages = toChatMessages([
      { id: 1, role: 'user', parts: [{ type: 'text', text: '想法' }] },
      { id: 2, role: 'tool', parts: [{ type: 'text', text: 'x' }] },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: '想法' }]);
  });

  it('completes a stored option card into a full tool part', () => {
    const [message] = toChatMessages([
      storedRecord([{ type: 'text', text: 'Run #234 还在队列中' }, { type: 'tool-present_options', options: STORED_OPTIONS }]),
    ]);

    expect(message?.parts[1]).toEqual({
      type: 'tool-present_options',
      toolCallId: 'stored-150-1',
      state: 'output-available',
      input: { options: STORED_OPTIONS },
      output: { status: 'shown' },
    });
  });

  it('leaves a streamed tool part alone', () => {
    const streamed = {
      type: 'tool-present_options',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { options: STORED_OPTIONS },
      output: { status: 'shown' },
    };

    const [message] = toChatMessages([storedRecord([streamed])]);
    expect(message?.parts[0]).toEqual(streamed);
  });

  it('converts a stored option card into a tool call with its result', async () => {
    const messages = toChatMessages([
      { id: 1, role: 'user', parts: [{ type: 'text', text: '推荐两个方向' }] },
      storedRecord([{ type: 'tool-present_options', options: STORED_OPTIONS }]),
      { id: 2, role: 'user', parts: [{ type: 'text', text: '选择：收窄方向重跑研究' }] },
    ]);

    const converted = await convertToModelMessages(messages as ChatMessage[]);
    const assistant = converted[1] as { content: { type: string; toolCallId?: string }[] };
    const tool = converted[2] as { role: string; content: { type: string; toolCallId?: string }[] };

    expect(assistant.content.map((part) => part.type)).toEqual(['tool-call']);
    expect(tool.role).toBe('tool');
    expect(tool.content[0]?.toolCallId).toBe(assistant.content[0]?.toolCallId);
  });
});
