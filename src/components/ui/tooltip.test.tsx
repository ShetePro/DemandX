import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

describe('Tooltip', () => {
  it('shows its content when the trigger receives keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>复制链接</TooltipTrigger>
          <TooltipContent>复制到剪贴板</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: '复制链接' })).toHaveFocus();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('复制到剪贴板');
  });
});
