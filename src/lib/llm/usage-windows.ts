/** Windows the settings panel and the quota guard read. */
export const USAGE_WINDOWS = ['5h', 'weekly', 'monthly'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/**
 * Start of the bucket a call belongs to, in UTC:
 * - `5h`: the 5-hour block (00:00, 05:00, …);
 * - `weekly`: Monday 00:00;
 * - `monthly`: the first day of the month.
 */
export function usageWindowStart(now: Date, window: UsageWindow): Date {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);

  switch (window) {
    case '5h':
      start.setUTCHours(Math.floor(start.getUTCHours() / 5) * 5);
      break;
    case 'weekly': {
      const daysSinceMonday = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - daysSinceMonday);
      start.setUTCHours(0);
      break;
    }
    case 'monthly':
      start.setUTCDate(1);
      start.setUTCHours(0);
      break;
  }

  return start;
}

