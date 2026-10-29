import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';

describe('Sheet', () => {
  it('opens from its trigger, exposes content, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>打开筛选</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>筛选条件</SheetTitle>
            <SheetDescription>按平台过滤证据</SheetDescription>
          </SheetHeader>
          <p>抽屉内容</p>
        </SheetContent>
      </Sheet>,
    );

    const trigger = screen.getByRole('button', { name: '打开筛选' });
    await user.click(trigger);

    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(screen.getByRole('heading', { name: '筛选条件' })).toBeVisible();
    expect(screen.getByText('抽屉内容')).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
