import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';

describe('Dialog', () => {
  it('opens a modal with its title and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>新建调查</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建调查</DialogTitle>
            <DialogDescription>填写关键词后开始采集。</DialogDescription>
          </DialogHeader>
          <p>弹窗内容</p>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: '新建调查' }));

    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(screen.getByRole('heading', { name: '新建调查' })).toBeVisible();
    expect(screen.getByText('弹窗内容')).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
