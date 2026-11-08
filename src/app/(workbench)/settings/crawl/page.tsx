import { PageHeader } from '@/components/common/page-header';
import { SettingsTabs } from '@/components/shell/settings-tabs';
import { HumanQueue } from '@/features/settings/crawl/human-queue';
import { LimitsForm } from '@/features/settings/crawl/limits-form';
import { PlatformCard } from '@/features/settings/crawl/platform-card';
import { PLATFORM_LOGIN_URLS } from '@/lib/crawl/platform-profile';
import { PLATFORM_LABELS } from '@/features/settings/crawl/platforms';
import { getCrawlSettingsAction } from '@/features/settings/crawl/actions';
import { WebSearchForm } from '@/features/settings/crawl/web-search-form';
import { getWebSearchSettingsAction } from '@/features/settings/crawl/web-search-actions';
import {
  PLATFORMS,
  platformProfileDir,
  readSessionStatus,
  type SessionStatus,
} from '@/lib/crawl/session-status';
import { listNeedsHuman } from '@/lib/runs/human-queue';

export const dynamic = 'force-dynamic';

/**
 * Platforms are cards, not a table: each one has one action and one piece of
 * state. A failed session read still renders the card as `missing` and the
 * reason is listed above the grid, never swallowed.
 */
async function readSessions(): Promise<{ sessions: SessionStatus[]; errors: string[] }> {
  const errors: string[] = [];
  const sessions = await Promise.all(
    PLATFORMS.map(async (platform) => {
      try {
        return await readSessionStatus(platform);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${platform}: ${message}`);
        return {
          platform,
          state: 'missing' as const,
          profileDir: platformProfileDir(platform),
          lastUsedAt: null,
        };
      }
    }),
  );
  return { sessions, errors };
}

export default async function CrawlSettingsPage() {
  const [settingsResult, queueResult, sessionsResult, webSearchResult] = await Promise.all([
    getCrawlSettingsAction(),
    listNeedsHuman(),
    readSessions(),
    getWebSearchSettingsAction(),
  ]);

  const errors = [
    ...sessionsResult.errors,
    ...(settingsResult.ok ? [] : [`采集设置：${settingsResult.message}`]),
    ...(queueResult.ok ? [] : [`待人工队列：${queueResult.message}`]),
    ...(webSearchResult.ok ? [] : [`兜底搜索：${webSearchResult.message}`]),
  ];

  const settings = settingsResult.ok ? settingsResult.value : null;
  const items = queueResult.ok ? queueResult.value : [];

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title="采集设置"
        description="平台会话只读目录状态；限速参数在每次 worker 任务开始时读取"
      />
      <SettingsTabs />

      {errors.length > 0 ? (
        <div
          role="alert"
          className="mb-4 flex flex-col gap-1 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-labelledby="sessions-heading" className="flex flex-col gap-3">
          <div>
            <h2 id="sessions-heading" className="text-sm font-semibold text-fg">
              平台会话
            </h2>
            <p className="mt-0.5 text-[11px] text-muted">
              只检查目录是否存在及最近修改时间，不读取 cookie 内容。
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {sessionsResult.sessions.map((status) => (
              <PlatformCard
                key={status.platform}
                status={status}
                loginUrl={PLATFORM_LOGIN_URLS[status.platform]}
              />
            ))}
          </ul>
          <p className="text-[11px] text-faint">
            登录窗口由 {PLATFORM_LABELS.xiaohongshu} / {PLATFORM_LABELS.douyin} /{' '}
            {PLATFORM_LABELS.zhihu} 各自的站点完成，完成后回到这里刷新即可。
          </p>
        </section>

        <div className="flex flex-col gap-4">
          {settings ? (
            <LimitsForm defaults={settings} />
          ) : (
            <section className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
              采集设置读取失败，暂时无法编辑。请先修复上方错误。
            </section>
          )}
          {webSearchResult.ok ? <WebSearchForm status={webSearchResult.value} /> : null}
        </div>
      </div>

      <div className="mt-6">
        <HumanQueue items={items} />
      </div>
    </div>
  );
}
