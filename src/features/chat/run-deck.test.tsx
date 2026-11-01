import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunDeck } from './run-deck';

vi.mock('./run-activity', () => ({
  RunActivity: ({ runId }: { runId: number }) => <article>card-{runId}</article>,
}));

describe('RunDeck', () => {
  it('renders every run as a card, newest on top', () => {
    render(
      <RunDeck
        runs={[
          { id: 7, status: 'failed', stage: 'S3', events: [] },
          { id: 8, status: 'running', stage: 'S1', events: [] },
        ]}
      />,
    );

    const cards = screen.getAllByRole('article').map((card) => card.textContent);
    expect(cards).toEqual(['card-8', 'card-7']);
  });

  it('invites a first run when the deck is empty', () => {
    render(<RunDeck runs={[]} />);
    expect(screen.getByText(/还没有研究记录/)).toBeVisible();
  });
});
