import type { PlatformUsage } from '@/lib/crawl/platform-usage';
import { formatRelativeTime } from '@/lib/utils/format';

import { PLATFORM_LABELS } from './platforms';

/**
 * What S1 actually crawled from each logged-in platform. A zero row is not a
 * failure: the search adapters are web/HN/Reddit/GitHub, so a platform page is
 * only fetched when one of those results points at its domain.
 */
export function PlatformUsageTable({ usage }: { usage: readonly PlatformUsage[] }) {
  return (
    <section aria-labelledby="platform-usage-heading" className="mt-6 flex flex-col gap-3">
      <div>
        <h2 id="platform-usage-heading" className="text-sm font-semibold text-fg">
          平台采集情况（最近 30 天）
        </h2>
        <p className="mt-0.5 text-[11px] text-muted">
          统计 sources 中属于这些平台的页面。搜索查询来自 Bing / DDG / HN / Reddit /
          GitHub；登录只影响爬取这些域名的页面，不会自动发起平台内搜索——只有当搜索结果指向这些域名时，才会用对应登录会话抓取。
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-2 text-[11px] text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">平台</th>
              <th className="px-3 py-2 font-medium">页面</th>
              <th className="px-3 py-2 font-medium">涉及 run</th>
              <th className="px-3 py-2 font-medium">最近抓取</th>
              <th className="px-3 py-2 font-medium">抓取方式</th>
            </tr>
          </thead>
          <tbody>
            {usage.map((item) => (
              <tr key={item.platform} className="border-t border-border">
                <td className="px-3 py-2 text-fg">
                  {PLATFORM_LABELS[item.platform] ?? item.platform}
                </td>
                <td className="px-3 py-2 tabular-nums text-fg">{item.pages}</td>
                <td className="px-3 py-2 tabular-nums text-muted">{item.runs}</td>
                <td className="px-3 py-2 text-muted">
                  {item.lastFetchedAt === null
                    ? '从未'
                    : formatRelativeTime(item.lastFetchedAt)}
                </td>
                <td className="px-3 py-2 text-muted">
                  {Object.entries(item.tiers)
                    .map(([tier, count]) => `${tier} ${count}`)
                    .join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
