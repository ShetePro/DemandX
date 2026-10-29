import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './button';

describe('Button', () => {
  it('does not call onClick while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        保存
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('activates on Space when enabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: '保存' })).toHaveFocus();

    await user.keyboard(' ');

    expect(onClick).toHaveBeenCalledOnce();
  });
});
