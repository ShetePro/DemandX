import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './composer';

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(<Composer onSend={onSend} onStop={onStop} {...props} />);
  return { onSend, onStop, textarea: screen.getByRole('textbox', { name: '输入消息' }) };
}

function enterEvent(init: KeyboardEventInit & { isComposing?: boolean }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isComposing', {
    configurable: true,
    value: init.isComposing ?? false,
  });
  return event;
}

describe('Composer', () => {
  it('sends the trimmed text on Enter', async () => {
    const user = userEvent.setup();
    const { onSend, textarea } = setup();

    await user.type(textarea, '  跨境库存同步  ');
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('跨境库存同步');
    expect(textarea).toHaveValue('');
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup();
    const { onSend, textarea } = setup();

    await user.type(textarea, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('第一行\n');
  });

  it('does not send while an IME is composing', () => {
    const { onSend, textarea } = setup();

    fireEvent.change(textarea, { target: { value: '拼音输入中' } });
    fireEvent(textarea, enterEvent({ isComposing: true }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables send for empty or whitespace-only input', async () => {
    const user = userEvent.setup();
    const { textarea } = setup();

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    await user.type(textarea, '   ');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('shows 停止 while streaming and calls stop', async () => {
    const user = userEvent.setup();
    const { onStop } = setup({ isStreaming: true });

    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '停止' }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
