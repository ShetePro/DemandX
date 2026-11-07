import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunDeck } from './run-deck';

vi.mock('./run-activity', () => ({
  RunActivity: ({ runId }: { runId: number }) => <article>card-{runId}</article>,
}));

const RUNS = [
  { id: 7, status: 'finished', stage: null, events: [] },
  { id: 8, status: 'running', stage: 'S1', events: [] },
  { id: 9, status: 'finished', stage: null, events: [] },
];

function wrapperOf(element: HTMLElement): HTMLElement {
  const wrapper = element.parentElement?.parentElement;
  if (wrapper === null || wrapper === undefined) throw new Error('card wrapper missing');
  return wrapper;
}

describe('RunDeck', () => {
  it('renders every run as a full card, oldest first and newest last', () => {
    render(<RunDeck runs={RUNS} />);

    const cards = screen.getAllByRole('article');
    expect(cards.map((card) => card.textContent)).toEqual(['card-7', 'card-8', 'card-9']);

    // Only the newest card takes its natural height; the rest are covered down
    // to their header strip so the pile never grows with the run count.
    expect(wrapperOf(cards[0]!).style.height).toBe('44px');
    expect(wrapperOf(cards[1]!).style.height).toBe('44px');
    expect(wrapperOf(cards[2]!).style.height).toBe('');
  });

  it('layers newer cards over older ones', () => {
    render(<RunDeck runs={RUNS} />);

    const layers = screen
      .getAllByRole('article')
      .map((card) => wrapperOf(card).style.zIndex);
    expect(layers).toEqual(['1', '2', '3']);
  });

  it('expands a covered card while the pointer is on it and folds it again', () => {
    render(<RunDeck runs={RUNS} />);

    const first = wrapperOf(screen.getAllByRole('article')[0]!);
    expect(first.style.height).toBe('44px');

    fireEvent.mouseEnter(first);
    // jsdom cannot measure the card, so the open height falls back to `auto`;
    // a real browser gets the measured pixel height so the change animates.
    expect(first.style.height).toBe('auto');

    fireEvent.mouseLeave(first);
    expect(first.style.height).toBe('44px');
  });

  it('expands a covered card when focus lands inside it', () => {
    render(<RunDeck runs={RUNS} />);

    const first = wrapperOf(screen.getAllByRole('article')[0]!);
    fireEvent.focus(first);
    expect(first.style.height).toBe('auto');

    fireEvent.blur(first);
    expect(first.style.height).toBe('44px');
  });

  it('invites a first run when the deck is empty', () => {
    render(<RunDeck runs={[]} />);
    expect(screen.getByText(/还没有研究记录/)).toBeVisible();
  });
});
