import { z } from 'zod';

/** Namespace used by the crawl settings page and the worker. */
export const CRAWL_SETTINGS_KEY = 'crawl';

/**
 * Crawl politeness and volume. Every field has a default, so a partial or
 * missing row still yields a usable configuration; values outside the ranges
 * are rejected rather than clamped, because silently replacing an operator's
 * 90-second delay with 8 seconds would hide a mistake.
 */
export const crawlSettingsSchema = z
  .strictObject({
    /** Browser tier off means static-only collection; it never disables search. */
    enabled: z.boolean().default(true),
    respectRobots: z.boolean().default(true),
    /** S1 crawls serially, so this is stored for a future pool, not enforced yet. */
    perHostConcurrency: z
      .number()
      .int('每主机并发必须是整数')
      .min(1, '每主机并发不能小于 1')
      .max(3, '每主机并发不能大于 3')
      .default(1),
    minDelayMs: z
      .number()
      .int('最小间隔必须是整数')
      .min(1000, '最小间隔不能小于 1000ms')
      .max(30000, '最小间隔不能大于 30000ms')
      .default(3000),
    maxDelayMs: z
      .number()
      .int('最大间隔必须是整数')
      .min(1000, '最大间隔不能小于 1000ms')
      .max(60000, '最大间隔不能大于 60000ms')
      .default(8000),
    maxPagesPerRun: z
      .number()
      .int('单次页数必须是整数')
      .min(10, '单次页数不能小于 10')
      .max(200, '单次页数不能大于 200')
      .default(120),
    deadlineMinutes: z
      .number()
      .int('超时分钟必须是整数')
      .min(10, '超时不能小于 10 分钟')
      .max(180, '超时不能大于 180 分钟')
      .default(90),
  })
  .superRefine((value, ctx) => {
    if (value.minDelayMs > value.maxDelayMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDelayMs'],
        message: '最大间隔不能小于最小间隔',
      });
    }
  });

export type CrawlSettings = z.output<typeof crawlSettingsSchema>;

/** What the worker and the page use when no row exists yet. */
export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = crawlSettingsSchema.parse({});

/**
 * One delay for the whole run, drawn once from `[minDelayMs, maxDelayMs]`.
 * `random` is injected so the choice is testable.
 */
export function pickDelayMs(settings: CrawlSettings, random: () => number = Math.random): number {
  const spread = settings.maxDelayMs - settings.minDelayMs;
  return settings.minDelayMs + Math.floor(random() * (spread + 1));
}
