import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './limiter';

/** Sleep advances a shared fake clock, so tests never wait in real time. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('does not delay the first request to a host', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      rps: 1,
      minDelayMs: 3_000,
      maxDelayMs: 8_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });

    await limiter.acquire('example.com');

    expect(clock.sleeps).toEqual([]);
  });

  it('spaces consecutive requests to the same host by max(1/rps, jitter)', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      rps: 2, // 500ms floor
      minDelayMs: 100,
      maxDelayMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });

    await limiter.acquire('example.com');
    await limiter.acquire('example.com');
    await limiter.acquire('example.com');

    expect(clock.sleeps).toEqual([500, 500]);
  });

  it('lets different hosts proceed without waiting for each other', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      rps: 1,
      minDelayMs: 3_000,
      maxDelayMs: 8_000,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });

    await Promise.all([limiter.acquire('a.example'), limiter.acquire('b.example')]);
    await limiter.acquire('a.example');

    // Only the second hit on a.example pays the 5.5s jittered gap.
    expect(clock.sleeps).toEqual([5_500]);
  });
});
