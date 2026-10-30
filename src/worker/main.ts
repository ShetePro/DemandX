import '@/lib/db/load-env';

import { homedir } from 'node:os';
import path from 'node:path';

import { PgBoss } from 'pg-boss';

import { createCrawler, type Crawler } from '@/lib/crawl';
import { createRobotsCache } from '@/lib/crawl/robots';
import { buildAngles } from '@/lib/pipeline/angles';
import { collectS1 } from '@/lib/pipeline/s1-collect';
import { createQuotaGuard } from '@/lib/quota/guard';
import { DEFAULT_QUOTA } from '@/lib/quota/policy';
import { appendEvent, getRunContext } from '@/lib/runs/repository';
import { S1_EXPIRE_SECONDS, S1_QUEUE, S1_RETRY_LIMIT } from '@/lib/runs/queue';
import { insertSource, listSourceUrls, recordQuery } from '@/lib/runs/sources-repository';
import { createAppStoreSearch } from '@/lib/search/appstore';
import { createBingSearch } from '@/lib/search/bing';
import { createDuckDuckGoSearch } from '@/lib/search/ddg';
import { createGitHubSearch } from '@/lib/search/github';
import { createHnSearch } from '@/lib/search/hn';
import type { SearchPort } from '@/lib/search/port';

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';

if (DATABASE_URL === '') {
  console.error(
    '❌ DATABASE_URL 未设置。复制 .env.example 为 .env 并运行 `docker compose up -d`。',
  );
  process.exit(1);
}

/** Env flags are opt-out, matching `.env.example`: absent means enabled. */
function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

const CRAWL_ENABLED = enabled(process.env.CRAWL_ENABLED);
const RESPECT_ROBOTS = enabled(process.env.CRAWL_RESPECT_ROBOTS);
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR?.trim() ?? '';

/** One persistent profile for pipeline crawls; `pnpm crawl:login` can seed it. */
const PROFILE_DIR =
  process.env.CRAWL_PROFILE_DIR?.trim() || path.join(homedir(), '.demandx', 'browser', 'pipeline');

const searchPorts: SearchPort[] = [
  createDuckDuckGoSearch(),
  createBingSearch(),
  createHnSearch(),
  createGitHubSearch(),
];

const appStoreAppId = process.env.APPSTORE_APP_ID?.trim() ?? '';
if (appStoreAppId !== '') searchPorts.push(createAppStoreSearch({ appId: appStoreAppId }));

/**
 * robots.txt is plain text, not a search result: read it directly so the
 * adapters' politeness limiter (which adds a 3–8s gap per host) does not
 * delay every first crawl of a domain.
 */
async function fetchRobots(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`robots.txt ${response.status}`);
  return response.text();
}

const crawler: Crawler = createCrawler({
  strategy: CRAWL_ENABLED ? 'auto' : 'static',
  ...(RESPECT_ROBOTS ? { robots: createRobotsCache({ fetchRobots }) } : {}),
  ...(CRAWL_ENABLED
    ? { browser: { profileDir: PROFILE_DIR, headless: process.env.CRAWL_HEADLESS !== 'false' } }
    : {}),
});

/** Event writes are best-effort telemetry: a lost event never stops a run. */
async function writeEvent(
  runId: number,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const written = await appendEvent(runId, type, payload);
  if (!written.ok) {
    console.error(`⚠️ run ${runId} 事件 ${type} 写入失败: ${written.message}`);
  }
}

async function runS1(runId: number): Promise<void> {
  const record = await getRunContext(runId);
  if (!record.ok) {
    console.error(`⚠️ run ${runId} 读取失败: ${record.message}`);
    return;
  }
  if (record.value === null) {
    console.error(`⚠️ run ${runId} 不存在，跳过该任务`);
    return;
  }

  const { idea, deadlineAt } = record.value;
  // S0 without an LLM: the angle names are the template classes, and collectS1
  // rebuilds the same groups from the idea.
  const ctx = {
    runId,
    idea,
    angles: buildAngles(idea).map((group) => group.angle),
    deadlineAt,
  };

  await writeEvent(runId, 'stage.started', { stage: 'S1' });

  const collected = await collectS1(ctx, {
    searchPorts,
    crawl: crawler,
    quota: createQuotaGuard({ policy: DEFAULT_QUOTA }),
    repo: { insertSource, listSourceUrls },
    recordQuery,
    ...(SNAPSHOT_DIR === '' ? {} : { snapshotDir: SNAPSHOT_DIR }),
    onEvent: (type, payload) => writeEvent(runId, type, payload),
  });

  if (!collected.ok) {
    await writeEvent(runId, 'stage.finished', {
      stage: 'S1',
      status: 'failed',
      code: collected.code,
    });
    await writeEvent(runId, 'run.failed', {
      stage: 'S1',
      code: collected.code,
      message: collected.message,
    });
    return;
  }

  await writeEvent(runId, 'stage.finished', { stage: 'S1', ...collected.value });
  await writeEvent(runId, 'run.finished', {
    stage: 'S1',
    status: 'finished',
    ...collected.value,
  });
}

const boss = new PgBoss(DATABASE_URL);
boss.on('error', (error) => {
  console.error('❌ pg-boss:', error);
});

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`⏹ 收到 ${signal}，正在停止 worker…`);

  try {
    await boss.stop({ graceful: true, timeout: 15_000, close: true });
  } catch (error) {
    console.error('⚠️ pg-boss 停止失败:', error);
  }
  try {
    await crawler.dispose();
  } catch (error) {
    console.error('⚠️ 浏览器上下文释放失败:', error);
  }

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await boss.start();
  // Idempotent: the producer also creates it, but a worker may start first.
  await boss.createQueue(S1_QUEUE, {
    retryLimit: S1_RETRY_LIMIT,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: S1_EXPIRE_SECONDS,
  });

  await boss.work<{ runId: number }>(S1_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const runId = job.data?.runId;
      if (!Number.isInteger(runId) || runId <= 0) {
        console.error('⚠️ 任务缺少合法的 runId，已跳过:', job.id);
        continue;
      }
      console.log(`▶️ run ${runId} S1 开始 (job ${job.id})`);
      try {
        await runS1(runId);
      } catch (error) {
        // A thrown programming error still becomes a terminal event, so the
        // SSE stream never hangs on a run no one will finish.
        console.error(`❌ run ${runId} S1 崩溃:`, error);
        await writeEvent(runId, 'run.failed', {
          stage: 'S1',
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  console.log(`✅ worker ready — 队列 ${S1_QUEUE}（CRAWL_ENABLED=${CRAWL_ENABLED}）`);
}

void main().catch((error: unknown) => {
  console.error('❌ worker 启动失败:', error);
  process.exitCode = 1;
  void boss.stop({ graceful: false }).catch(() => undefined);
});
