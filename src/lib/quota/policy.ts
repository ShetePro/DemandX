/** Bucket width of one quota counter. Windows are aligned to UTC. */
export type QuotaWindow = 'minute' | 'day' | 'week' | 'month';

export const QUOTA_WINDOWS: readonly QuotaWindow[] = ['minute', 'day', 'week', 'month'];

/**
 * Maximum external requests per source per window. Sources are search engines,
 * platform scrapers and the LLM, keyed by name (`github`, `hn`, `ddg`, …) — not
 * by `providers.id`, because most of them are not provider rows at all.
 */
export type QuotaPolicy = Record<string, { window: QuotaWindow; limit: number }>;

/**
 * Deliberately conservative defaults: they slow a run down, never silently open
 * a second paid account. `llm` caps calls to the configured chain as a whole.
 */
export const DEFAULT_QUOTA: QuotaPolicy = {
  github: { window: 'minute', limit: 10 },
  hn: { window: 'minute', limit: 60 },
  appstore: { window: 'minute', limit: 30 },
  ddg: { window: 'minute', limit: 5 },
  bing: { window: 'minute', limit: 5 },
  llm: { window: 'minute', limit: 60 },
};

/**
 * Start of the window containing `now`, in UTC. Weeks start on Monday (UTC),
 * matching how "weekly limits" are usually reported; days and months floor to
 * their first instant, and a minute floors to :00.000.
 */
export function windowStart(window: QuotaWindow, now: Date): Date {
  const time = now.getTime();
  if (Number.isNaN(time)) throw new RangeError('now 必须是有效日期');

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  switch (window) {
    case 'minute':
      return new Date(Date.UTC(year, month, day, now.getUTCHours(), now.getUTCMinutes()));
    case 'day':
      return new Date(Date.UTC(year, month, day));
    case 'week': {
      // Sunday (getUTCDay() === 0) belongs to the week that started six days ago.
      const daysSinceMonday = (now.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(year, month, day - daysSinceMonday));
    }
    case 'month':
      return new Date(Date.UTC(year, month, 1));
  }
}
